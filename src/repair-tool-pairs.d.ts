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
type AnyMessage = Record<string, unknown>;
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
export declare function repairToolPairs(messages: AnyMessage[]): AnyMessage[];
export {};
//# sourceMappingURL=repair-tool-pairs.d.ts.map