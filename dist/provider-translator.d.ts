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
import type { NeutralMessage, NeutralToolResult, ProviderMessage } from './types.js';
/**
 * Final pair-integrity sweep before provider translation.
 *
 * Invariant: never emit a tool_result unless its matching tool_use/tool_call
 * exists in the immediately prior assistant message with the same ID.
 *
 * If the pair is broken, degrade the orphan tool_result into plain user text
 * so providers never see an invalid tool_result block.
 */
export declare function repairToolCallPairs(messages: NeutralMessage[]): NeutralMessage[];
/**
 * Generate a hypermem-native tool call ID.
 * These are provider-neutral and deterministic within a session.
 */
export declare function generateToolCallId(): string;
/**
 * Convert a provider-specific tool call ID to a hypermem ID.
 * Deterministic: same input always produces same output.
 */
export declare function normalizeToolCallId(providerId: string): string;
export type ProviderType = 'anthropic' | 'openai' | 'openai-responses' | 'unknown';
export declare function detectProvider(providerString: string | null | undefined): ProviderType;
/**
 * Convert neutral messages to provider-specific format.
 */
export declare function toProviderFormat(messages: NeutralMessage[], provider: string | null | undefined): ProviderMessage[];
/**
 * Convert a provider-specific response to neutral format.
 */
export declare function fromProviderFormat(response: Record<string, unknown>, provider: string): NeutralMessage;
/**
 * Convert a user message (from chat input) to neutral format.
 */
export declare function userMessageToNeutral(content: string, metadata?: Record<string, unknown>): NeutralMessage;
/**
 * Convert tool results to a neutral user message.
 */
export declare function toolResultsToNeutral(results: NeutralToolResult[]): NeutralMessage;
//# sourceMappingURL=provider-translator.d.ts.map