import type { NeutralMessage, StoredMessage } from './types.js';
import {
  isInlineSnapshotSlotPayload,
  type SnapshotJsonValue,
  type SnapshotSlotsRecord,
} from './composition-snapshot-integrity.js';

interface BuildCompositionSnapshotSlotsInput {
  system: string | null | undefined;
  identity: string | null | undefined;
  repairNotice?: string | null | undefined;
  messages: NeutralMessage[];
  contextBlock?: string;
}

export interface RestoredWarmSnapshotState {
  system?: string;
  identity?: string;
  history: StoredMessage[];
}

function toSnapshotInlineContent(content: SnapshotJsonValue): { kind: 'inline'; content: SnapshotJsonValue } {
  return { kind: 'inline', content };
}

function normalizeSnapshotMessage(message: NeutralMessage): SnapshotJsonValue {
  const base: Record<string, SnapshotJsonValue> = {
    role: message.role,
    textContent: message.textContent,
    toolCalls: message.toolCalls as SnapshotJsonValue,
    toolResults: message.toolResults as SnapshotJsonValue,
  };

  const stored = message as Partial<StoredMessage>;
  if (typeof stored.id === 'number') base.id = stored.id;
  if (typeof stored.conversationId === 'number') base.conversationId = stored.conversationId;
  if (typeof stored.agentId === 'string') base.agentId = stored.agentId;
  if (typeof stored.messageIndex === 'number') base.messageIndex = stored.messageIndex;
  if (typeof stored.tokenCount === 'number' || stored.tokenCount === null) base.tokenCount = stored.tokenCount ?? null;
  if (typeof stored.isHeartbeat === 'boolean') base.isHeartbeat = stored.isHeartbeat;
  if (typeof stored.createdAt === 'string') base.createdAt = stored.createdAt;
  if (message.metadata && typeof message.metadata === 'object') base.metadata = message.metadata as SnapshotJsonValue;

  return base;
}

export function buildCompositionSnapshotSlots(input: BuildCompositionSnapshotSlotsInput): SnapshotSlotsRecord {
  const stablePrefix = input.messages
    .filter(message => message.role === 'system')
    .map(message => normalizeSnapshotMessage(message));
  const history = input.messages
    .filter(message => message.role !== 'system')
    .map(message => normalizeSnapshotMessage(message));

  const slots: SnapshotSlotsRecord = {
    system: toSnapshotInlineContent(input.system ?? ''),
    identity: toSnapshotInlineContent(input.identity ?? ''),
    stable_prefix: toSnapshotInlineContent(stablePrefix),
    history: toSnapshotInlineContent(history),
  };

  if (input.repairNotice) {
    slots.repair_notice = toSnapshotInlineContent(input.repairNotice);
  }

  if (input.contextBlock) {
    slots.context_block = toSnapshotInlineContent(input.contextBlock);
  }

  return slots;
}

function extractInlineContent(slotValue: SnapshotJsonValue | undefined): SnapshotJsonValue | undefined {
  if (!slotValue || !isInlineSnapshotSlotPayload(slotValue)) return undefined;
  return slotValue.content;
}

function isMessageRole(value: unknown): value is NeutralMessage['role'] {
  return value === 'user' || value === 'assistant' || value === 'system';
}

function restoreStoredMessages(value: SnapshotJsonValue | undefined): StoredMessage[] | null {
  if (!Array.isArray(value)) return null;

  const restored: StoredMessage[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    if (!isMessageRole(row.role) || row.role === 'system') return null;
    if (row.textContent !== null && typeof row.textContent !== 'string') return null;

    restored.push({
      id: typeof row.id === 'number' ? row.id : 0,
      conversationId: typeof row.conversationId === 'number' ? row.conversationId : 0,
      agentId: typeof row.agentId === 'string' ? row.agentId : '',
      role: row.role,
      textContent: (row.textContent as string | null) ?? null,
      toolCalls: Array.isArray(row.toolCalls) ? (row.toolCalls as StoredMessage['toolCalls']) : null,
      toolResults: Array.isArray(row.toolResults) ? (row.toolResults as StoredMessage['toolResults']) : null,
      metadata: typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
        ? row.metadata as Record<string, unknown>
        : undefined,
      messageIndex: typeof row.messageIndex === 'number' ? row.messageIndex : 0,
      tokenCount: typeof row.tokenCount === 'number' ? row.tokenCount : null,
      isHeartbeat: typeof row.isHeartbeat === 'boolean' ? row.isHeartbeat : false,
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date(0).toISOString(),
    });
  }

  return restored;
}

export function restoreWarmSnapshotState(slots: SnapshotSlotsRecord): RestoredWarmSnapshotState | null {
  const history = restoreStoredMessages(extractInlineContent(slots.history));
  if (!history || history.length === 0) return null;

  const restoreStringSlot = (key: string): string | undefined => {
    const value = extractInlineContent(slots[key]);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  return {
    system: restoreStringSlot('system'),
    identity: restoreStringSlot('identity'),
    history: history.map(message => ({
      ...message,
      metadata: { ...(message.metadata || {}), _warmed: true },
    })),
  };
}
