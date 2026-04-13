/**
 * repair-tool-pairs.ts
 *
 * Strips orphaned tool result entries from a pi-agent message array.
 *
 * Background: HyperMem compaction and in-memory trim passes can remove assistant
 * messages that contain tool_use/toolCall blocks without removing the corresponding
 * tool result messages that follow them. Anthropic and Gemini reject these orphaned
 * tool results with a 400 error.
 *
 * This module provides a pure repair function that can be applied at any output
 * boundary to sanitise the message list before it reaches the provider.
 *
 * Supported formats:
 *   - pi-agent: role:'toolResult' messages with toolCallId field
 *   - Anthropic native: user messages with content blocks of type:'tool_result' and tool_use_id
 *
 * Returns a new array. Does not mutate the input.
 */
/**
 * Repair orphaned tool pairs in a pi-agent / OpenClaw message array.
 *
 * Orphan types handled:
 *   1. role:'toolResult' message whose toolCallId has no matching toolCall/tool_use
 *      block in any assistant message in the array.
 *   2. User message whose content contains only type:'tool_result' blocks where all
 *      of those blocks reference a tool_use_id that does not appear in any assistant
 *      message in the array. (Anthropic-native format.)
 *
 * Also strips orphaned assistant messages that contain ONLY tool_use/toolCall blocks
 * where none of those calls has a corresponding tool result anywhere in the array.
 *
 * Returns a new array (does not mutate input).
 */
export function repairToolPairs(messages) {
    if (!Array.isArray(messages) || messages.length === 0)
        return messages;
    // ── Pass 1: Collect all valid tool call IDs from assistant messages ────────
    const validCallIds = new Set();
    for (const msg of messages) {
        if (msg.role !== 'assistant')
            continue;
        // NeutralMessage format: msg.toolCalls[]
        if (Array.isArray(msg.toolCalls)) {
            for (const tc of msg.toolCalls) {
                if (typeof tc.id === 'string' && tc.id)
                    validCallIds.add(tc.id);
            }
        }
        // Content array format: type:'toolCall' or type:'tool_use' blocks
        if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if ((block.type === 'toolCall' || block.type === 'tool_use') &&
                    typeof block.id === 'string' &&
                    block.id) {
                    validCallIds.add(block.id);
                }
            }
        }
    }
    // ── Pass 2: Collect all result IDs that have a valid call ─────────────────
    const validResultIds = new Set();
    for (const msg of messages) {
        // pi-agent ToolResultMessage
        if (msg.role === 'toolResult') {
            const id = typeof msg.toolCallId === 'string' ? msg.toolCallId :
                typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
            if (id && validCallIds.has(id))
                validResultIds.add(id);
        }
        // Anthropic-native tool_result blocks inside user messages
        if (msg.role === 'user' && Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id) {
                    if (validCallIds.has(block.tool_use_id))
                        validResultIds.add(block.tool_use_id);
                }
            }
        }
    }
    // ── Pass 3: Filter out orphaned messages / blocks ─────────────────────────
    const result = [];
    for (const msg of messages) {
        // ── pi-agent ToolResultMessage ─────────────────────────────────────────
        if (msg.role === 'toolResult') {
            const id = typeof msg.toolCallId === 'string' ? msg.toolCallId :
                typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
            if (!id || !validCallIds.has(id)) {
                // Orphaned — drop
                continue;
            }
            result.push(msg);
            continue;
        }
        // ── Anthropic-native: user message with tool_result content blocks ─────
        if (msg.role === 'user' && Array.isArray(msg.content)) {
            const content = msg.content;
            const hasToolResultBlocks = content.some(b => b.type === 'tool_result');
            if (hasToolResultBlocks) {
                const filteredContent = content.filter(block => {
                    if (block.type !== 'tool_result')
                        return true; // keep non-tool_result blocks
                    const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
                    return toolUseId && validCallIds.has(toolUseId);
                });
                // If the message became empty after stripping all orphaned tool_result blocks, skip it
                if (filteredContent.length === 0)
                    continue;
                result.push({ ...msg, content: filteredContent });
                continue;
            }
        }
        // ── Assistant message with ONLY unmatched tool_use/toolCall blocks ─────
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            const content = msg.content;
            const toolCallBlocks = content.filter(b => b.type === 'toolCall' || b.type === 'tool_use');
            const nonToolCallBlocks = content.filter(b => b.type !== 'toolCall' && b.type !== 'tool_use');
            // Only strip if the assistant message is purely tool-calls (no text)
            if (toolCallBlocks.length > 0 && nonToolCallBlocks.length === 0) {
                const hasAnyResult = toolCallBlocks.some(b => {
                    const id = typeof b.id === 'string' ? b.id : '';
                    return id && validResultIds.has(id);
                });
                if (!hasAnyResult) {
                    // Pure tool-call block with no paired results — drop
                    continue;
                }
            }
        }
        result.push(msg);
    }
    const dropped = messages.length - result.length;
    if (dropped > 0) {
        console.log(`[hypermem] repairToolPairs: dropped ${dropped} orphaned message(s) (${messages.length} → ${result.length})`);
    }
    return result;
}
//# sourceMappingURL=repair-tool-pairs.js.map