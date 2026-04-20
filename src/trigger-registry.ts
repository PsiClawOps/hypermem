/**
 * hypermem Trigger Registry (W5)
 *
 * Centralizes ACA collection trigger definitions with owner/category metadata.
 * Extracted from compositor.ts for independent testability and auditability.
 *
 * - TRIGGER_REGISTRY_VERSION: semver string for the registry schema
 * - TRIGGER_REGISTRY_HASH:    12-char SHA-256 of (collection, keywords) per entry
 * - logRegistryStartup():     emits version + hash on first Compositor boot
 */

import { createHash } from 'node:crypto';

// ─── Interface ────────────────────────────────────────────────

/**
 * A trigger definition maps a collection to the conversation signals that
 * indicate it should be queried. When any keyword matches the user's latest
 * message, the compositor fetches relevant chunks from that collection.
 *
 * Centralizing trigger logic here (not in workspace stubs) means:
 * - One update propagates to all agents
 * - Stubs become documentation, not code
 * - Trigger logic can be tested independently
 *
 * W5 additions: owner, category, description (all optional — backward compat).
 */
export interface CollectionTrigger {
  /** Collection path: governance/policy, identity/job, etc. */
  collection: string;
  /** Keywords that trigger this collection (case-insensitive) */
  keywords: string[];
  /** Max tokens to inject from this collection */
  maxTokens?: number;
  /** Max chunks to retrieve */
  maxChunks?: number;
  // W5 additions:
  /** Which agent/team owns this trigger set */
  owner?: string;
  /** Logical grouping: 'governance' | 'identity' | 'memory' | 'operations' */
  category?: string;
  /** Human-readable purpose */
  description?: string;
}

// ─── Registry ─────────────────────────────────────────────────

export const TRIGGER_REGISTRY_VERSION = '1.0.0';

/**
 * Default trigger registry for standard ACA collections.
 * Covers the core ACA offload use case from carol's spec.
 */
export const TRIGGER_REGISTRY: CollectionTrigger[] = [
  {
    collection: 'governance/policy',
    keywords: [
      'escalat', 'policy', 'decision state', 'green', 'yellow', 'red',
      'council procedure', 'naming', 'mandate', 'compliance', 'governance',
      'override', 'human review', 'irreversible',
    ],
    maxTokens: 1500,
    maxChunks: 3,
    owner: 'council',
    category: 'governance',
    description: 'Governance policy: escalation triggers, decision states, naming rules, compliance mandates',
  },
  {
    collection: 'governance/charter',
    keywords: [
      'charter', 'mission', 'director', 'org', 'reporting', 'boundary',
      'delegation', 'authority', 'jurisdiction',
    ],
    maxTokens: 1000,
    maxChunks: 2,
    owner: 'council',
    category: 'governance',
    description: 'Organizational charter: mission, director roles, authority boundaries, delegation scope',
  },
  {
    collection: 'governance/comms',
    keywords: [
      'message', 'send', 'tier 1', 'tier 2', 'tier 3', 'async', 'dispatch',
      'sessions_send', 'inter-agent', 'protocol', 'comms', 'ping', 'notify',
    ],
    maxTokens: 800,
    maxChunks: 2,
    owner: 'council',
    category: 'governance',
    description: 'Inter-agent communication protocols: message tiers, dispatch rules, session messaging',
  },
  {
    collection: 'operations/agents',
    keywords: [
      'boot', 'startup', 'bootstrap', 'heartbeat', 'workqueue', 'checkpoint',
      'session start', 'roll call', 'memory recall', 'dispatch inbox',
    ],
    maxTokens: 800,
    maxChunks: 2,
    owner: 'alice',
    category: 'operations',
    description: 'Agent operational procedures: boot sequence, heartbeat, work queue, session startup',
  },
  {
    collection: 'identity/job',
    keywords: [
      'deliberat', 'council round', 'vote', 'response contract', 'rating',
      'first response', 'second response', 'handoff', 'floor open',
      'performance', 'output discipline', 'assessment',
    ],
    maxTokens: 1200,
    maxChunks: 3,
    owner: 'council',
    category: 'identity',
    description: 'Agent job definitions: council deliberation roles, response contracts, performance standards',
  },
  {
    collection: 'identity/motivations',
    keywords: [
      'motivation', 'fear', 'tension', 'why do you', 'how do you feel',
      'drives', 'values',
    ],
    maxTokens: 600,
    maxChunks: 1,
    owner: 'council',
    category: 'identity',
    description: 'Agent motivations and values: intrinsic drivers, tensions, emotional context',
  },
  {
    collection: 'memory/decisions',
    keywords: [
      'remember', 'decision', 'we decided', 'previously', 'last time',
      'history', 'past', 'earlier', 'recall', 'context',
    ],
    maxTokens: 1500,
    maxChunks: 4,
    owner: 'alice',
    category: 'memory',
    description: 'Decision history: past choices, previously agreed approaches, recalled context',
  },
  {
    collection: 'identity/soul',
    keywords: [
      'who are you', 'your role', 'your purpose', 'your domain', 'your job',
      'identity', 'soul', 'persona', 'what do you do', 'how do you work',
      'your principles', 'your values', 'your seat',
    ],
    maxTokens: 1200,
    maxChunks: 2,
    owner: 'council',
    category: 'identity',
    description: 'Agent soul and persona: role definition, domain ownership, core principles',
  },
  {
    collection: 'operations/tools',
    keywords: [
      'tool', 'config', 'command', 'cli', 'path', 'deploy', 'restart',
      'openclaw', 'session_status', 'model', 'plugin', 'workspace path',
      'how to', 'where is', 'which command', 'quick ref',
    ],
    maxTokens: 1200,
    maxChunks: 3,
    owner: 'alice',
    category: 'operations',
    description: 'Agent tooling reference: CLI commands, config paths, deployment procedures, quick reference',
  },
];

/** Backward-compat alias — same reference as TRIGGER_REGISTRY */
export const DEFAULT_TRIGGERS = TRIGGER_REGISTRY;

// ─── Registry Hash ────────────────────────────────────────────

/**
 * 12-char SHA-256 of the registry's (collection, keywords) pairs.
 * Changes when trigger definitions change; stable across metadata-only edits.
 * Computed once at module load.
 */
export const TRIGGER_REGISTRY_HASH: string = createHash('sha256')
  .update(JSON.stringify(TRIGGER_REGISTRY.map(t => ({ collection: t.collection, keywords: t.keywords }))))
  .digest('hex')
  .slice(0, 12);

// ─── matchTriggers ────────────────────────────────────────────

/**
 * Match a user message against the trigger registry.
 * Returns triggered collections (deduplicated, ordered by trigger specificity).
 */
export function matchTriggers(
  userMessage: string,
  triggers: CollectionTrigger[]
): CollectionTrigger[] {
  if (!userMessage) return [];
  const lower = userMessage.toLowerCase();
  return triggers.filter(t =>
    t.keywords.some(kw => lower.includes(kw.toLowerCase()))
  );
}

// ─── Startup Log ──────────────────────────────────────────────

/**
 * Emit a one-line startup log with registry version, hash, and entry count.
 * Call once per process via the Compositor constructor guard.
 */
export function logRegistryStartup(): void {
  console.log(
    `[hypermem:triggers] version=${TRIGGER_REGISTRY_VERSION} hash=${TRIGGER_REGISTRY_HASH} entries=${TRIGGER_REGISTRY.length}`
  );
}
