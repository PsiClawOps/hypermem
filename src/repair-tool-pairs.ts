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
export function repairToolPairs(messages: AnyMessage[]): AnyMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  // ── Pass 1: Collect all valid tool call IDs from assistant messages ────────
  const validCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;

    // NeutralMessage format: msg.toolCalls[]
    if (Array.isArray(msg.toolCalls)) {
      for (const tc of msg.toolCalls as AnyMessage[]) {
        if (typeof tc.id === 'string' && tc.id) validCallIds.add(tc.id);
      }
    }

    // Content array format: type:'toolCall' or type:'tool_use' blocks
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as AnyMessage[]) {
        if (
          (block.type === 'toolCall' || block.type === 'tool_use') &&
          typeof block.id === 'string' &&
          block.id
        ) {
          validCallIds.add(block.id);
        }
      }
    }
  }

  // ── Pass 2: Collect all result IDs that have a valid call ─────────────────
  const validResultIds = new Set<string>();
  for (const msg of messages) {
    // pi-agent ToolResultMessage
    if (msg.role === 'toolResult') {
      const id =
        typeof msg.toolCallId === 'string' ? msg.toolCallId :
        typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
      if (id && validCallIds.has(id)) validResultIds.add(id);
    }

    // Anthropic-native tool_result blocks inside user messages
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content as AnyMessage[]) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id) {
          if (validCallIds.has(block.tool_use_id)) validResultIds.add(block.tool_use_id);
        }
      }
    }
  }

  // ── Pass 3: Filter out orphaned messages / blocks ─────────────────────────
  const result: AnyMessage[] = [];

  for (const msg of messages) {
    // ── pi-agent ToolResultMessage ─────────────────────────────────────────
    if (msg.role === 'toolResult') {
      const id =
        typeof msg.toolCallId === 'string' ? msg.toolCallId :
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
      const content = msg.content as AnyMessage[];
      const hasToolResultBlocks = content.some(b => b.type === 'tool_result');

      if (hasToolResultBlocks) {
        const filteredContent = content.filter(block => {
          if (block.type !== 'tool_result') return true; // keep non-tool_result blocks
          const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
          return toolUseId && validCallIds.has(toolUseId);
        });

        // If the message became empty after stripping all orphaned tool_result blocks, skip it
        if (filteredContent.length === 0) continue;

        result.push({ ...msg, content: filteredContent });
        continue;
      }
    }

    // ── Assistant message with ONLY unmatched tool_use/toolCall blocks ─────
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const content = msg.content as AnyMessage[];
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

  // ── Pass 4: Intra-message content block integrity ─────────────────────────
  // Anthropic requires that every tool_result content block in a user message
  // references a tool_use_id that exists in the IMMEDIATELY PRECEDING assistant
  // message's content blocks. Pass 3 only checks global existence. This pass
  // enforces adjacency.
  let intraBlockDropped = 0;
  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

    const content = msg.content as AnyMessage[];
    const hasToolResultBlocks = content.some(b => b.type === 'tool_result');
    if (!hasToolResultBlocks) continue;

    // Find the immediately preceding assistant message
    let precedingAssistant: AnyMessage | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (result[j].role === 'assistant') {
        precedingAssistant = result[j];
        break;
      }
    }

    // Collect tool_use IDs from the preceding assistant message only
    const adjacentCallIds = new Set<string>();
    if (precedingAssistant) {
      // Content array format
      if (Array.isArray(precedingAssistant.content)) {
        for (const block of precedingAssistant.content as AnyMessage[]) {
          if (
            (block.type === 'toolCall' || block.type === 'tool_use') &&
            typeof block.id === 'string' && block.id
          ) {
            adjacentCallIds.add(block.id);
          }
        }
      }
      // NeutralMessage format
      if (Array.isArray(precedingAssistant.toolCalls)) {
        for (const tc of precedingAssistant.toolCalls as AnyMessage[]) {
          if (typeof tc.id === 'string' && tc.id) adjacentCallIds.add(tc.id);
        }
      }
    }

    // Also check pi-agent ToolResultMessages that reference the preceding assistant
    // (these are message-level, not content-block level — skip for adjacency check)

    // Filter: keep tool_result blocks only if their tool_use_id is in the
    // immediately preceding assistant message
    const filteredContent = content.filter(block => {
      if (block.type !== 'tool_result') return true;
      const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      if (!toolUseId) return false; // malformed, drop
      if (adjacentCallIds.has(toolUseId)) return true;
      intraBlockDropped++;
      return false;
    });

    if (filteredContent.length === 0) {
      // All content blocks were orphaned — remove the message entirely
      result.splice(i, 1);
      i--; // re-check this index
    } else if (filteredContent.length !== content.length) {
      result[i] = { ...msg, content: filteredContent };
    }
  }

  const dropped = messages.length - result.length;
  if (dropped > 0 || intraBlockDropped > 0) {
    const parts: string[] = [];
    if (dropped > 0) parts.push(`${dropped} orphaned message(s)`);
    if (intraBlockDropped > 0) parts.push(`${intraBlockDropped} intra-message orphaned content block(s)`);
    console.log(`[hypermem] repairToolPairs: dropped ${parts.join(' + ')} (${messages.length} → ${result.length})`);
  }

  return result;
}
