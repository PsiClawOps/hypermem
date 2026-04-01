/**
 * HyperMem Provider Translator
 *
 * Converts between provider-neutral (NeutralMessage) and provider-specific formats.
 * This is the ONLY place where provider-specific formatting exists.
 * Storage is always neutral. Translation happens at the send/receive boundary.
 *
 * This eliminates grafting/stripping entirely — tool calls are stored as structured
 * data, and each provider gets the format it expects at send time.
 */

import type {
  NeutralMessage,
  NeutralToolCall,
  NeutralToolResult,
  ProviderMessage,
} from './types.js';
import { createHash } from 'node:crypto';

// ─── ID Generation ───────────────────────────────────────────────

let idCounter = 0;

/**
 * Generate a HyperMem-native tool call ID.
 * These are provider-neutral and deterministic within a session.
 */
export function generateToolCallId(): string {
  idCounter++;
  const timestamp = Date.now().toString(36);
  const counter = idCounter.toString(36).padStart(4, '0');
  return `hm_${timestamp}_${counter}`;
}

/**
 * Convert a provider-specific tool call ID to a HyperMem ID.
 * Deterministic: same input always produces same output.
 */
export function normalizeToolCallId(providerId: string): string {
  if (providerId.startsWith('hm_')) return providerId; // already normalized
  const hash = createHash('sha256').update(providerId).digest('hex').substring(0, 12);
  return `hm_${hash}`;
}

// ─── Provider Detection ──────────────────────────────────────────

export type ProviderType = 'anthropic' | 'openai' | 'openai-responses' | 'unknown';

export function detectProvider(providerString: string | null | undefined): ProviderType {
  if (!providerString) return 'unknown';
  const lower = providerString.toLowerCase();
  if (lower.includes('anthropic') || lower.includes('claude')) return 'anthropic';
  if (lower.includes('codex') || lower.includes('responses')) return 'openai-responses';
  if (lower.includes('openai') || lower.includes('gpt') || lower.includes('copilot')) return 'openai';
  return 'unknown';
}

// ─── To Provider Format ──────────────────────────────────────────

/**
 * Convert neutral messages to Anthropic Messages API format.
 */
function toAnthropic(messages: NeutralMessage[]): ProviderMessage[] {
  const result: ProviderMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Anthropic system messages are handled separately (system parameter)
      // Include them as-is; the gateway will extract them
      result.push({ role: 'system', content: msg.textContent || '' });
      continue;
    }

    if (msg.role === 'assistant') {
      const content: unknown[] = [];

      if (msg.textContent) {
        content.push({ type: 'text', text: msg.textContent });
      }

      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id, // will need to be un-normalized if Anthropic expects toolu_ prefix
            name: tc.name,
            input: JSON.parse(tc.arguments),
          });
        }
      }

      result.push({
        role: 'assistant',
        content: content.length === 1 && typeof content[0] === 'object' && (content[0] as Record<string, unknown>).type === 'text'
          ? msg.textContent || ''
          : content,
      });
      continue;
    }

    if (msg.role === 'user') {
      // Tool results go as user messages with tool_result content blocks
      if (msg.toolResults && msg.toolResults.length > 0) {
        const content: unknown[] = [];
        for (const tr of msg.toolResults) {
          content.push({
            type: 'tool_result',
            tool_use_id: tr.callId,
            content: tr.content,
            is_error: tr.isError || false,
          });
        }
        result.push({ role: 'user', content });
      } else {
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
function toOpenAI(messages: NeutralMessage[]): ProviderMessage[] {
  const result: ProviderMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      result.push({ role: 'system', content: msg.textContent || '' });
      continue;
    }

    if (msg.role === 'assistant') {
      const providerMsg: ProviderMessage = {
        role: 'assistant',
        content: msg.textContent || null,
      };

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        providerMsg.tool_calls = msg.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        }));
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
      } else {
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
function toOpenAIResponses(messages: NeutralMessage[]): ProviderMessage[] {
  // Responses API uses a different item format
  // For now, use the same as Chat Completions — the gateway handles the conversion
  // This is a stub for when we need direct Responses API support
  return toOpenAI(messages);
}

/**
 * Convert neutral messages to provider-specific format.
 */
export function toProviderFormat(
  messages: NeutralMessage[],
  provider: string | null | undefined
): ProviderMessage[] {
  const providerType = detectProvider(provider);

  switch (providerType) {
    case 'anthropic':
      return toAnthropic(messages);
    case 'openai':
      return toOpenAI(messages);
    case 'openai-responses':
      return toOpenAIResponses(messages);
    default:
      // Default to OpenAI format as it's most widely compatible
      return toOpenAI(messages);
  }
}

// ─── From Provider Format ────────────────────────────────────────

/**
 * Convert an Anthropic response to neutral format.
 */
function fromAnthropic(response: Record<string, unknown>): NeutralMessage {
  const content = response.content as Array<Record<string, unknown>> | string;
  let textContent: string | null = null;
  let toolCalls: NeutralToolCall[] | null = null;

  if (typeof content === 'string') {
    textContent = content;
  } else if (Array.isArray(content)) {
    const textParts: string[] = [];
    const tools: NeutralToolCall[] = [];

    for (const block of content) {
      if (block.type === 'text') {
        textParts.push(block.text as string);
      } else if (block.type === 'tool_use') {
        tools.push({
          id: normalizeToolCallId(block.id as string),
          name: block.name as string,
          arguments: JSON.stringify(block.input),
        });
      }
    }

    if (textParts.length > 0) textContent = textParts.join('\n');
    if (tools.length > 0) toolCalls = tools;
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
function fromOpenAI(choice: Record<string, unknown>): NeutralMessage {
  const message = choice.message as Record<string, unknown> | undefined
    || choice as Record<string, unknown>;

  const textContent = (message.content as string) || null;
  let toolCalls: NeutralToolCall[] | null = null;

  const rawToolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
  if (rawToolCalls && rawToolCalls.length > 0) {
    toolCalls = rawToolCalls.map(tc => ({
      id: normalizeToolCallId(tc.id as string),
      name: (tc.function as Record<string, unknown>).name as string,
      arguments: (tc.function as Record<string, unknown>).arguments as string,
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
export function fromProviderFormat(
  response: Record<string, unknown>,
  provider: string
): NeutralMessage {
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
export function userMessageToNeutral(content: string, metadata?: Record<string, unknown>): NeutralMessage {
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
export function toolResultsToNeutral(results: NeutralToolResult[]): NeutralMessage {
  return {
    role: 'user',
    textContent: null,
    toolCalls: null,
    toolResults: results,
  };
}
