/**
 * Knowledge Lint
 *
 * Health checks for the knowledge table:
 *  1. Stale syntheses — decay confidence on old topic-synthesis entries
 *  2. Orphan topics — topics with too few messages, stale > 48h
 *  3. Coverage gaps — topics with many messages but no synthesis
 */
import type { DatabaseSync } from 'node:sqlite';
export interface LintResult {
    staleDecayed: number;
    orphansFound: number;
    orphansPruned: number;
    coverageGaps: string[];
}
export declare const ORPHAN_PRUNE_DAYS = 14;
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
export declare function lintKnowledge(libraryDb: DatabaseSync): LintResult;
//# sourceMappingURL=knowledge-lint.d.ts.map