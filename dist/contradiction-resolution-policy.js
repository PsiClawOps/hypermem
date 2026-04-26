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
export const DEFAULT_CONTRADICTION_POLICY = {
    autoSupersedeThreshold: 0.80,
    autoInvalidateThreshold: 0.60,
    alwaysAudit: true,
};
//# sourceMappingURL=contradiction-resolution-policy.js.map