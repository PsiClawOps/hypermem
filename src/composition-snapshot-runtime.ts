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
  diagnostics: WarmSnapshotRestoreDiagnostics;
}

export interface WarmSnapshotRestoreDiagnostics {
  sourceProvider: string | null;
  targetProvider: string | null;
  crossProviderBoundary: boolean;
  requiredSlotDrops: string[];
  requiredSlotDropRate: number;
  stablePrefixBoundaryViolations: number;
  toolPairParityViolations: number;
  quotedAssistantTurns: number;
  continuityCriticalBoundaryTransformCount: number;
  continuityCriticalBoundaryTransformRate: number;
  tokenParityDriftSampleCount: number;
  tokenParityDriftP95: number;
  tokenParityDriftP99: number;
  rolloutGatePassed: boolean;
  rolloutGateViolations: WarmRestoreRolloutGateViolation[];
}

export interface WarmRestoreRolloutGateViolation {
  gate: keyof typeof WARM_RESTORE_MEASUREMENT_GATES;
  actual: number;
  max: number;
}

export interface RestoreWarmSnapshotOptions {
  sourceProvider?: string | null;
  targetProvider?: string | null;
}

export const WARM_RESTORE_MEASUREMENT_GATES = Object.freeze({
  tokenParityDriftP95Max: 0.03,
  tokenParityDriftP99Max: 0.05,
  requiredSlotDropRateMax: 0,
  stablePrefixBoundaryViolationsMax: 0,
  toolPairParityViolationsMax: 0,
  continuityCriticalBoundaryTransformRateMax: 0.005,
});

export function evaluateWarmRestoreRolloutGate(
  diagnostics: Pick<WarmSnapshotRestoreDiagnostics,
    | 'tokenParityDriftP95'
    | 'tokenParityDriftP99'
    | 'requiredSlotDropRate'
    | 'stablePrefixBoundaryViolations'
    | 'toolPairParityViolations'
    | 'continuityCriticalBoundaryTransformRate'
  >,
): { passed: boolean; violations: WarmRestoreRolloutGateViolation[] } {
  const violations: WarmRestoreRolloutGateViolation[] = [];
  const check = (gate: keyof typeof WARM_RESTORE_MEASUREMENT_GATES, actual: number) => {
    const max = WARM_RESTORE_MEASUREMENT_GATES[gate];
    if (actual > max) violations.push({ gate, actual, max });
  };

  check('tokenParityDriftP95Max', diagnostics.tokenParityDriftP95);
  check('tokenParityDriftP99Max', diagnostics.tokenParityDriftP99);
  check('requiredSlotDropRateMax', diagnostics.requiredSlotDropRate);
  check('stablePrefixBoundaryViolationsMax', diagnostics.stablePrefixBoundaryViolations);
  check('toolPairParityViolationsMax', diagnostics.toolPairParityViolations);
  check('continuityCriticalBoundaryTransformRateMax', diagnostics.continuityCriticalBoundaryTransformRate);

  return { passed: violations.length === 0, violations };
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

function estimateTextTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateToolTokens(value: unknown): number {
  if (!value) return 0;
  return Math.ceil(JSON.stringify(value).length / 2);
}

function estimateStoredMessageTokens(message: Pick<StoredMessage, 'textContent' | 'toolCalls' | 'toolResults'>): number {
  return estimateTextTokens(message.textContent)
    + estimateToolTokens(message.toolCalls)
    + estimateToolTokens(message.toolResults)
    + 4;
}

function computeRelativeTokenDrift(baselineTokens: number, restoredTokens: number): number {
  if (baselineTokens <= 0) return restoredTokens > 0 ? 1 : 0;
  return Math.abs(restoredTokens - baselineTokens) / baselineTokens;
}

function computePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile) - 1));
  return sorted[rank] ?? 0;
}

function quoteForeignProviderAssistantTurns(
  history: StoredMessage[],
  sourceProvider: string | null,
  targetProvider: string | null,
): { history: StoredMessage[]; quotedAssistantTurns: number; toolPairParityViolations: number } {
  if (!sourceProvider || !targetProvider || sourceProvider === targetProvider) {
    return { history, quotedAssistantTurns: 0, toolPairParityViolations: 0 };
  }

  let quotedAssistantTurns = 0;
  let toolPairParityViolations = 0;

  const quotedHistory = history.map(message => {
    if (message.role !== 'assistant') return message;

    quotedAssistantTurns++;
    const hadToolPayload = Boolean(
      (message.toolCalls && message.toolCalls.length > 0)
      || (message.toolResults && message.toolResults.length > 0)
    );
    if (hadToolPayload) toolPairParityViolations++;

    const quotedText = (message.textContent && message.textContent.trim().length > 0)
      ? `"""${message.textContent.trim()}"""`
      : '[no text content retained]';
    const prefix = `Historical assistant turn from ${sourceProvider} provider, quoted for ${targetProvider} replay.`;
    const toolGap = hadToolPayload
      ? '[tool call/result payload omitted at cross-provider boundary]'
      : null;

    return {
      ...message,
      role: 'user' as const,
      textContent: [prefix, quotedText, toolGap].filter(Boolean).join('\n'),
      toolCalls: null,
      toolResults: null,
      metadata: {
        ...(message.metadata || {}),
        _historicalQuote: true,
        _quotedFromRole: 'assistant',
        _quotedSourceProvider: sourceProvider,
        _quotedTargetProvider: targetProvider,
      },
    };
  });

  return { history: quotedHistory, quotedAssistantTurns, toolPairParityViolations };
}

export function restoreWarmSnapshotState(
  slots: SnapshotSlotsRecord,
  options?: RestoreWarmSnapshotOptions,
): RestoredWarmSnapshotState | null {
  const requiredSlotDrops: string[] = [];
  if (extractInlineContent(slots.system) === undefined) requiredSlotDrops.push('system');
  if (extractInlineContent(slots.identity) === undefined) requiredSlotDrops.push('identity');
  if (extractInlineContent(slots.history) === undefined) requiredSlotDrops.push('history');

  const stablePrefixBoundaryViolations = Array.isArray(extractInlineContent(slots.stable_prefix)) ? 0 : 1;
  const history = restoreStoredMessages(extractInlineContent(slots.history));
  if (!history || history.length === 0) return null;

  const sourceProvider = options?.sourceProvider ?? null;
  const targetProvider = options?.targetProvider ?? null;
  const quoted = quoteForeignProviderAssistantTurns(history, sourceProvider, targetProvider);
  const continuityCriticalBoundaryTransformCount = quoted.quotedAssistantTurns;
  const continuityCriticalBoundaryTransformRate = quoted.history.length > 0
    ? continuityCriticalBoundaryTransformCount / quoted.history.length
    : 0;

  const restoreStringSlot = (key: string): string | undefined => {
    const value = extractInlineContent(slots[key]);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  const restoredSystem = restoreStringSlot('system');
  const restoredIdentity = restoreStringSlot('identity');
  const tokenParityDriftSamples: number[] = [];
  const originalSystem = extractInlineContent(slots.system);
  if (typeof originalSystem === 'string' && restoredSystem !== undefined) {
    tokenParityDriftSamples.push(
      computeRelativeTokenDrift(estimateTextTokens(originalSystem), estimateTextTokens(restoredSystem)),
    );
  }
  const originalIdentity = extractInlineContent(slots.identity);
  if (typeof originalIdentity === 'string' && restoredIdentity !== undefined) {
    tokenParityDriftSamples.push(
      computeRelativeTokenDrift(estimateTextTokens(originalIdentity), estimateTextTokens(restoredIdentity)),
    );
  }
  for (let i = 0; i < history.length && i < quoted.history.length; i++) {
    tokenParityDriftSamples.push(
      computeRelativeTokenDrift(
        estimateStoredMessageTokens(history[i]),
        estimateStoredMessageTokens(quoted.history[i]),
      ),
    );
  }

  const baseDiagnostics = {
    sourceProvider,
    targetProvider,
    crossProviderBoundary: Boolean(sourceProvider && targetProvider && sourceProvider !== targetProvider),
    requiredSlotDrops,
    requiredSlotDropRate: requiredSlotDrops.length / 3,
    stablePrefixBoundaryViolations,
    toolPairParityViolations: quoted.toolPairParityViolations,
    quotedAssistantTurns: quoted.quotedAssistantTurns,
    continuityCriticalBoundaryTransformCount,
    continuityCriticalBoundaryTransformRate,
    tokenParityDriftSampleCount: tokenParityDriftSamples.length,
    tokenParityDriftP95: computePercentile(tokenParityDriftSamples, 0.95),
    tokenParityDriftP99: computePercentile(tokenParityDriftSamples, 0.99),
  };
  const rolloutGate = evaluateWarmRestoreRolloutGate(baseDiagnostics);

  return {
    system: restoredSystem,
    identity: restoredIdentity,
    history: quoted.history.map(message => ({
      ...message,
      metadata: { ...(message.metadata || {}), _warmed: true },
    })),
    diagnostics: {
      ...baseDiagnostics,
      rolloutGatePassed: rolloutGate.passed,
      rolloutGateViolations: rolloutGate.violations,
    },
  };
}
