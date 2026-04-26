/**
 * hypermem Provider Translator
 *
 * Converts between provider-neutral (NeutralMessage) and provider-specific formats.
 * This is the ONLY place where provider-specific formatting exists.
 * Storage is always neutral. Translation happens at the send/receive boundary.
 *
 * This eliminates grafting/stripping entirely — tool calls are stored as structured
 * data, and each provider gets the format it expects at send time.
 */
function summarizeOrphanToolResult(tr) {
    const toolName = tr.name || 'tool';
    const status = tr.isError ? 'error' : 'result';
    const content = (tr.content || '').replace(/\s+/g, ' ').trim();
    const preview = content.length > 160 ? `${content.slice(0, 157)}...` : content;
    return preview
        ? `[${toolName} ${status} omitted: missing matching tool call] ${preview}`
        : `[${toolName} ${status} omitted: missing matching tool call]`;
}
/**
 * Final pair-integrity sweep before provider translation.
 *
 * Invariant: never emit a tool_result unless its matching tool_use/tool_call
 * exists in the immediately prior assistant message with the same ID.
 *
 * If the pair is broken, degrade the orphan tool_result into plain user text
 * so providers never see an invalid tool_result block.
 */
export function repairToolCallPairs(messages) {
    const repaired = [];
    for (const msg of messages) {
        if (msg.role !== 'user' || !msg.toolResults || msg.toolResults.length === 0) {
            repaired.push(msg);
            continue;
        }
        const prev = repaired[repaired.length - 1];
        const validCallIds = new Set(prev?.role === 'assistant' && prev.toolCalls
            ? prev.toolCalls.map(tc => tc.id)
            : []);
        const keptResults = msg.toolResults.filter(tr => validCallIds.has(tr.callId));
        const orphanResults = msg.toolResults.filter(tr => !validCallIds.has(tr.callId));
        if (orphanResults.length === 0) {
            repaired.push(msg);
            continue;
        }
        const orphanText = orphanResults.map(summarizeOrphanToolResult).join('\n');
        const mergedText = [msg.textContent, orphanText].filter(Boolean).join('\n');
        if (keptResults.length > 0) {
            repaired.push({
                ...msg,
                textContent: mergedText || msg.textContent,
                toolResults: keptResults,
            });
            continue;
        }
        repaired.push({
            ...msg,
            textContent: mergedText || msg.textContent || '[tool result omitted: missing matching tool call]',
            toolResults: null,
        });
    }
    return repaired;
}
import { createHash } from 'node:crypto';
// ─── ID Generation ───────────────────────────────────────────────
let idCounter = 0;
/**
 * Generate a hypermem-native tool call ID.
 * These are provider-neutral and deterministic within a session.
 */
export function generateToolCallId() {
    idCounter++;
    const timestamp = Date.now().toString(36);
    const counter = idCounter.toString(36).padStart(4, '0');
    return `hm_${timestamp}_${counter}`;
}
/**
 * Convert a provider-specific tool call ID to a hypermem ID.
 * Deterministic: same input always produces same output.
 */
export function normalizeToolCallId(providerId) {
    if (providerId.startsWith('hm_'))
        return providerId; // already normalized
    const hash = createHash('sha256').update(providerId).digest('hex').substring(0, 12);
    return `hm_${hash}`;
}
export function detectProvider(providerString) {
    if (!providerString)
        return 'unknown';
    const lower = providerString.toLowerCase();
    if (lower.includes('anthropic') || lower.includes('claude'))
        return 'anthropic';
    if (lower.includes('codex') || lower.includes('responses'))
        return 'openai-responses';
    if (lower.includes('openai') || lower.includes('gpt') || lower.includes('copilot'))
        return 'openai';
    return 'unknown';
}
// ─── To Provider Format ──────────────────────────────────────────
/**
 * Convert neutral messages to Anthropic Messages API format.
 *
 * Prompt caching (DYNAMIC_BOUNDARY):
 * Anthropic supports prompt caching via cache_control on content blocks.
 * The last system message BEFORE the dynamicBoundary marker gets
 * cache_control: {type: "ephemeral"} to mark the static/dynamic boundary.
 *
 * Static (cacheable): system prompt + identity + stable output profile prefix
 * Dynamic (not cacheable): context block (facts/recall/recent actions), conversation history
 *
 * This allows Anthropic to cache the static prefix and skip re-tokenizing it.
 */
function toAnthropic(messages) {
    const result = [];
    // Find the last static system message index (before any dynamicBoundary message)
    // so we can mark it with cache_control.
    let lastStaticSystemIdx = -1;
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === 'system' && !msg.metadata?.dynamicBoundary) {
            lastStaticSystemIdx = i;
        }
        else if (msg.metadata?.dynamicBoundary) {
            // Stop scanning — everything after the boundary marker is dynamic
            break;
        }
    }
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === 'system') {
            // Anthropic system messages are handled separately (system parameter)
            // Include them as-is; the gateway will extract them.
            // Mark the last static system message as the cache boundary.
            const isLastStatic = i === lastStaticSystemIdx;
            const providerMsg = {
                role: 'system',
                content: msg.textContent || '',
            };
            if (isLastStatic) {
                // Add cache_control as a hint to the gateway/Anthropic API.
                // The gateway is responsible for lifting this into the correct API position.
                providerMsg.cache_control = { type: 'ephemeral' };
            }
            result.push(providerMsg);
            continue;
        }
        if (msg.role === 'assistant') {
            const content = [];
            if (msg.textContent) {
                content.push({ type: 'text', text: msg.textContent });
            }
            if (msg.toolCalls) {
                for (const tc of msg.toolCalls) {
                    // tc may be a NeutralToolCall { id, name, arguments: string }
                    // or a raw OpenClaw content block { type, id, name, input: object }
                    const rawTc = tc;
                    let input;
                    if (rawTc.input !== undefined) {
                        // Raw content block format — input is already an object
                        input = typeof rawTc.input === 'string' ? JSON.parse(rawTc.input) : rawTc.input;
                    }
                    else if (tc.arguments !== undefined) {
                        // NeutralToolCall format — arguments is a JSON string
                        input = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : (tc.arguments ?? {});
                    }
                    else {
                        input = {};
                    }
                    content.push({
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.name,
                        input,
                    });
                }
            }
            result.push({
                role: 'assistant',
                content: content.length === 1 && typeof content[0] === 'object' && content[0].type === 'text'
                    ? msg.textContent || ''
                    : content,
            });
            continue;
        }
        if (msg.role === 'user') {
            // Tool results go as user messages with tool_result content blocks
            if (msg.toolResults && msg.toolResults.length > 0) {
                const content = [];
                for (const tr of msg.toolResults) {
                    content.push({
                        type: 'tool_result',
                        tool_use_id: tr.callId,
                        content: tr.content,
                        is_error: tr.isError || false,
                    });
                }
                result.push({ role: 'user', content });
            }
            else {
                result.push({ role: 'user', content: msg.textContent || '' });
            }
            continue;
        }
    }
    return result;
}
/**
 * Convert neutral messages to OpenAI Chat Completions API format.
 */
function toOpenAI(messages) {
    const result = [];
    for (const msg of messages) {
        if (msg.role === 'system') {
            result.push({ role: 'system', content: msg.textContent || '' });
            continue;
        }
        if (msg.role === 'assistant') {
            const providerMsg = {
                role: 'assistant',
                content: msg.textContent || null,
            };
            if (msg.toolCalls && msg.toolCalls.length > 0) {
                providerMsg.tool_calls = msg.toolCalls.map(tc => {
                    // Handle both NeutralToolCall { arguments: string } and raw content block { input: object }
                    const rawTc = tc;
                    let args;
                    if (rawTc.input !== undefined) {
                        args = typeof rawTc.input === 'string' ? rawTc.input : JSON.stringify(rawTc.input);
                    }
                    else if (tc.arguments !== undefined) {
                        args = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments);
                    }
                    else {
                        args = '{}';
                    }
                    return {
                        id: tc.id,
                        type: 'function',
                        function: {
                            name: tc.name,
                            arguments: args,
                        },
                    };
                });
            }
            result.push(providerMsg);
            continue;
        }
        if (msg.role === 'user') {
            if (msg.toolResults && msg.toolResults.length > 0) {
                // OpenAI tool results are separate "tool" role messages
                for (const tr of msg.toolResults) {
                    result.push({
                        role: 'tool',
                        tool_call_id: tr.callId,
                        content: tr.content,
                    });
                }
            }
            else {
                result.push({ role: 'user', content: msg.textContent || '' });
            }
            continue;
        }
    }
    return result;
}
/**
 * Convert neutral messages to OpenAI Responses API format.
 */
function toOpenAIResponses(messages) {
    // Responses API uses a different item format
    // For now, use the same as Chat Completions — the gateway handles the conversion
    // This is a stub for when we need direct Responses API support
    return toOpenAI(messages);
}
/**
 * Convert neutral messages to provider-specific format.
 */
export function toProviderFormat(messages, provider) {
    const repairedMessages = repairToolCallPairs(messages);
    const providerType = detectProvider(provider);
    switch (providerType) {
        case 'anthropic':
            return toAnthropic(repairedMessages);
        case 'openai':
            return toOpenAI(repairedMessages);
        case 'openai-responses':
            return toOpenAIResponses(repairedMessages);
        default:
            // Default to OpenAI format as it's most widely compatible
            return toOpenAI(repairedMessages);
    }
}
// ─── From Provider Format ────────────────────────────────────────
/**
 * Convert an Anthropic response to neutral format.
 */
function fromAnthropic(response) {
    const content = response.content;
    let textContent = null;
    let toolCalls = null;
    if (typeof content === 'string') {
        textContent = content;
    }
    else if (Array.isArray(content)) {
        const textParts = [];
        const tools = [];
        for (const block of content) {
            if (block.type === 'text') {
                textParts.push(block.text);
            }
            else if (block.type === 'tool_use') {
                tools.push({
                    id: normalizeToolCallId(block.id),
                    name: block.name,
                    arguments: JSON.stringify(block.input),
                });
            }
        }
        if (textParts.length > 0)
            textContent = textParts.join('\n');
        if (tools.length > 0)
            toolCalls = tools;
    }
    return {
        role: 'assistant',
        textContent,
        toolCalls,
        toolResults: null,
        metadata: {
            originalProvider: 'anthropic',
            stopReason: response.stop_reason,
            model: response.model,
        },
    };
}
/**
 * Convert an OpenAI response choice to neutral format.
 */
function fromOpenAI(choice) {
    const message = choice.message
        || choice;
    const textContent = message.content || null;
    let toolCalls = null;
    const rawToolCalls = message.tool_calls;
    if (rawToolCalls && rawToolCalls.length > 0) {
        toolCalls = rawToolCalls.map(tc => ({
            id: normalizeToolCallId(tc.id),
            name: tc.function.name,
            arguments: tc.function.arguments,
        }));
    }
    return {
        role: 'assistant',
        textContent,
        toolCalls,
        toolResults: null,
        metadata: {
            originalProvider: 'openai',
            finishReason: message.finish_reason || choice.finish_reason,
        },
    };
}
/**
 * Convert a provider-specific response to neutral format.
 */
export function fromProviderFormat(response, provider) {
    const providerType = detectProvider(provider);
    switch (providerType) {
        case 'anthropic':
            return fromAnthropic(response);
        case 'openai':
        case 'openai-responses':
            return fromOpenAI(response);
        default:
            return fromOpenAI(response);
    }
}
/**
 * Convert a user message (from chat input) to neutral format.
 */
export function userMessageToNeutral(content, metadata) {
    return {
        role: 'user',
        textContent: content,
        toolCalls: null,
        toolResults: null,
        metadata,
    };
}
/**
 * Convert tool results to a neutral user message.
 */
export function toolResultsToNeutral(results) {
    return {
        role: 'user',
        textContent: null,
        toolCalls: null,
        toolResults: results,
    };
}
//# sourceMappingURL=provider-translator.js.map