/**
 * Knowledge Lint
 *
 * Health checks for the knowledge table:
 *  1. Stale syntheses — decay confidence on old topic-synthesis entries
 *  2. Orphan topics — topics with too few messages, stale > 48h
 *  3. Coverage gaps — topics with many messages but no synthesis
 */
import { LINT_STALE_DAYS } from './topic-synthesizer.js';
// Orphan topics older than this many days are eligible for pruning.
// 48h = report threshold, 14d = prune threshold (conservative).
export const ORPHAN_PRUNE_DAYS = 14;
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
export function lintKnowledge(libraryDb) {
    const result = {
        staleDecayed: 0,
        orphansFound: 0,
        orphansPruned: 0,
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
    `).all(Math.floor(LINT_STALE_DAYS));
        for (const entry of staleSyntheses) {
            // Extract topic id from source_ref: "topic:<id>" or "topic:<id>:mc:<count>"
            if (!entry.source_ref)
                continue;
            const match = entry.source_ref.match(/^topic:(\d+)/);
            if (!match)
                continue;
            const topicId = parseInt(match[1], 10);
            // Check if topic exists and is stale (no recent updates)
            let topicRow;
            try {
                topicRow = libraryDb.prepare('SELECT updated_at, message_count FROM topics WHERE id = ?').get(topicId);
            }
            catch {
                continue;
            }
            if (!topicRow)
                continue;
            // Check if topic is stale (updated_at older than LINT_STALE_DAYS)
            const topicAge = libraryDb.prepare(`
        SELECT CASE WHEN datetime(?) < datetime('now', '-' || ? || ' days') THEN 1 ELSE 0 END AS is_stale
      `).get(topicRow.updated_at, Math.floor(LINT_STALE_DAYS));
            if (topicAge.is_stale) {
                // Decay confidence to 0.3
                libraryDb.prepare('UPDATE knowledge SET confidence = 0.3, updated_at = datetime(\'now\') WHERE id = ?').run(entry.id);
                result.staleDecayed++;
            }
        }
    }
    catch {
        // Non-fatal — continue with other checks
    }
    // ── 2. Orphan topics ───────────────────────────────────────────
    // Topics with message_count < 3 and updated_at > 48h ago
    try {
        const orphans = libraryDb.prepare(`
      SELECT id, name, message_count, updated_at FROM topics
      WHERE message_count < 3
        AND updated_at < datetime('now', '-48 hours')
    `).all();
        result.orphansFound = orphans.length;
        if (orphans.length > 0) {
            const sample = orphans.slice(0, 10).map(o => o.name).join(', ');
            const remainder = Math.max(0, orphans.length - 10);
            console.log(`[lint] ${orphans.length} orphan topic(s) found (< 3 messages, stale > 48h)` +
                (sample ? `; sample: ${sample}` : '') +
                (remainder > 0 ? `; +${remainder} more` : ''));
        }
        // Prune orphan topics older than ORPHAN_PRUNE_DAYS (conservative cleanup).
        // Safety: only prune topics with no knowledge-synthesis entries and no facts
        // referencing them (via source_ref 'topic:<id>' pattern).
        try {
            const prunable = libraryDb.prepare(`
        SELECT t.id, t.name FROM topics t
        WHERE t.message_count < 3
          AND t.updated_at < datetime('now', '-' || ? || ' days')
          AND NOT EXISTS (
            SELECT 1 FROM knowledge k
            WHERE k.agent_id = t.agent_id
              AND k.domain = 'topic-synthesis'
              AND k.key = t.name
              AND k.superseded_by IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM facts f
            WHERE f.source_ref LIKE 'topic:' || t.id || '%'
          )
      `).all(ORPHAN_PRUNE_DAYS);
            if (prunable.length > 0) {
                const ids = prunable.map(p => p.id);
                const placeholders = ids.map(() => '?').join(',');
                libraryDb.prepare(`DELETE FROM topics WHERE id IN (${placeholders})`).run(...ids);
                result.orphansPruned = prunable.length;
                console.log(`[lint] pruned ${prunable.length} orphan topic(s) (< 3 messages, stale > ${ORPHAN_PRUNE_DAYS}d, no syntheses or facts)`);
            }
        }
        catch (err) {
            console.warn('[lint] orphan prune failed (non-fatal):', err.message);
        }
    }
    catch {
        // Non-fatal
    }
    // ── 3. Coverage gaps ───────────────────────────────────────────
    // Topics with >= 20 messages but no synthesis in knowledge table
    try {
        const bigTopics = libraryDb.prepare(`
      SELECT t.name, t.agent_id
      FROM topics t
      WHERE t.message_count >= 20
    `).all();
        for (const topic of bigTopics) {
            const synthesis = libraryDb.prepare(`
        SELECT id FROM knowledge
        WHERE agent_id = ?
          AND domain = 'topic-synthesis'
          AND key = ?
          AND superseded_by IS NULL
        LIMIT 1
      `).get(topic.agent_id, topic.name);
            if (!synthesis) {
                result.coverageGaps.push(topic.name);
            }
        }
    }
    catch {
        // Non-fatal
    }
    return result;
}
//# sourceMappingURL=knowledge-lint.js.map