/**
 * hypermem Contradiction Resolution Policy
 *
 * Defines thresholds and flags that control how the background indexer acts
 * on detected contradictions during fact ingest.
 *
 * Tiers (by contradictionScore):
 *   >= autoSupersedeThreshold  → mark old fact superseded, remove stale vector
 *   >= autoInvalidateThreshold → mark old fact invalid (no supersede linkage)
 *   below autoInvalidateThreshold → log-only (pending review)
 */

export interface ContradictionResolutionPolicy {
  /** Score threshold at or above which the old fact is auto-superseded by the new one. Default: 0.80 */
  autoSupersedeThreshold: number;
  /** Score threshold at or above which the old fact is auto-invalidated. Default: 0.60 */
  autoInvalidateThreshold: number;
  /** When true, always write an audit row regardless of tier. Default: true */
  alwaysAudit: boolean;
}

export const DEFAULT_CONTRADICTION_POLICY: ContradictionResolutionPolicy = {
  autoSupersedeThreshold: 0.80,
  autoInvalidateThreshold: 0.60,
  alwaysAudit: true,
};
