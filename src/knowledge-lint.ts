/**
 * Knowledge Lint
 *
 * Health checks for the knowledge table:
 *  1. Stale syntheses — decay confidence on old topic-synthesis entries
 *  2. Orphan topics — topics with too few messages, stale > 48h
 *  3. Coverage gaps — topics with many messages but no synthesis
 */

import type { DatabaseSync } from 'node:sqlite';
import { LINT_STALE_DAYS } from './topic-synthesizer.js';

// ─── Types ──────────────────────────────────────────────────────

export interface LintResult {
  staleDecayed: number;
  orphansFound: number;
  coverageGaps: string[];  // topic names needing synthesis
}

// ─── lintKnowledge ──────────────────────────────────────────────

/**
 * Run lint checks on the knowledge table.
 *
 * 1. Stale syntheses: topic-synthesis entries where the source topic's
 *    updated_at is older than LINT_STALE_DAYS and there are no new messages.
 *    Marks these with confidence = 0.3.
 *
 * 2. Orphan topics: topics with message_count < 3 and updated_at older than 48h.
 *    Logged but not synthesized.
 *
 * 3. Coverage gaps: topics with message_count >= 20 but no corresponding
 *    knowledge entry (domain='topic-synthesis', key=topic.name).
 */
export function lintKnowledge(libraryDb: DatabaseSync): LintResult {
  const result: LintResult = {
    staleDecayed: 0,
    orphansFound: 0,
    coverageGaps: [],
  };

  // ── 1. Stale syntheses ─────────────────────────────────────────
  // Find topic-synthesis knowledge entries whose source topic hasn't been
  // updated in LINT_STALE_DAYS days.
  try {
    const staleSyntheses = libraryDb.prepare(`
      SELECT k.id, k.source_ref, k.agent_id, k.key
      FROM knowledge k
      WHERE k.domain = 'topic-synthesis'
        AND k.superseded_by IS NULL
        AND k.updated_at < datetime('now', '-' || ? || ' days')
    `).all(Math.floor(LINT_STALE_DAYS)) as Array<{ id: number; source_ref: string | null; agent_id: string; key: string }>;

    for (const entry of staleSyntheses) {
      // Extract topic id from source_ref: "topic:<id>" or "topic:<id>:mc:<count>"
      if (!entry.source_ref) continue;
      const match = entry.source_ref.match(/^topic:(\d+)/);
      if (!match) continue;
      const topicId = parseInt(match[1], 10);

      // Check if topic exists and is stale (no recent updates)
      let topicRow: { updated_at: string; message_count: number } | undefined;
      try {
        topicRow = libraryDb.prepare(
          'SELECT updated_at, message_count FROM topics WHERE id = ?'
        ).get(topicId) as { updated_at: string; message_count: number } | undefined;
      } catch {
        continue;
      }

      if (!topicRow) continue;

      // Check if topic is stale (updated_at older than LINT_STALE_DAYS)
      const topicAge = libraryDb.prepare(`
        SELECT CASE WHEN datetime(?) < datetime('now', '-' || ? || ' days') THEN 1 ELSE 0 END AS is_stale
      `).get(topicRow.updated_at, Math.floor(LINT_STALE_DAYS)) as { is_stale: number };

      if (topicAge.is_stale) {
        // Decay confidence to 0.3
        libraryDb.prepare(
          'UPDATE knowledge SET confidence = 0.3, updated_at = datetime(\'now\') WHERE id = ?'
        ).run(entry.id);
        result.staleDecayed++;
      }
    }
  } catch {
    // Non-fatal — continue with other checks
  }

  // ── 2. Orphan topics ───────────────────────────────────────────
  // Topics with message_count < 3 and updated_at > 48h ago
  try {
    const orphans = libraryDb.prepare(`
      SELECT id, name, message_count, updated_at FROM topics
      WHERE message_count < 3
        AND updated_at < datetime('now', '-48 hours')
    `).all() as Array<{ id: number; name: string; message_count: number; updated_at: string }>;

    result.orphansFound = orphans.length;

    if (orphans.length > 0) {
      const sample = orphans.slice(0, 10).map(o => o.name).join(', ');
      const remainder = Math.max(0, orphans.length - 10);
      console.log(
        `[lint] ${orphans.length} orphan topic(s) found (< 3 messages, stale > 48h)` +
        (sample ? `; sample: ${sample}` : '') +
        (remainder > 0 ? `; +${remainder} more` : '')
      );
    }
  } catch {
    // Non-fatal
  }

  // ── 3. Coverage gaps ───────────────────────────────────────────
  // Topics with >= 20 messages but no synthesis in knowledge table
  try {
    const bigTopics = libraryDb.prepare(`
      SELECT t.name, t.agent_id
      FROM topics t
      WHERE t.message_count >= 20
    `).all() as Array<{ name: string; agent_id: string }>;

    for (const topic of bigTopics) {
      const synthesis = libraryDb.prepare(`
        SELECT id FROM knowledge
        WHERE agent_id = ?
          AND domain = 'topic-synthesis'
          AND key = ?
          AND superseded_by IS NULL
        LIMIT 1
      `).get(topic.agent_id, topic.name) as { id: number } | undefined;

      if (!synthesis) {
        result.coverageGaps.push(topic.name);
      }
    }
  } catch {
    // Non-fatal
  }

  return result;
}
