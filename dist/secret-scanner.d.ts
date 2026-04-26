/**
 * hypermem Secret Scanner
 *
 * Lightweight regex-based gate to prevent secrets from leaking into
 * shared memory (visibility >= 'org'). Runs before any write that
 * promotes content to org/council/fleet visibility.
 *
 * Design principles:
 *   - Fast: regex-only, no LLM dependency
 *   - Conservative: false positives are okay; false negatives are not
 *   - Auditable: each hit includes the rule name and matched region (redacted)
 *   - Not a full DLP system: blocks the obvious leaks; does not guarantee clean content
 *
 * Patterns sourced from:
 *   - gitleaks ruleset (https://github.com/gitleaks/gitleaks)
 *   - trufflehog common patterns
 *   - Manual additions for OpenClaw-specific secrets
 */
export interface ScanResult {
    clean: boolean;
    hits: ScanHit[];
}
export interface ScanHit {
    rule: string;
    description: string;
    /** Redacted match — only first/last 3 chars of the matched value */
    redactedMatch: string;
    /** Character offset of the match start */
    offset: number;
}
/**
 * Scan content for secrets before promoting to shared visibility.
 *
 * Returns { clean: true } when no secrets found.
 * Returns { clean: false, hits } when secrets are detected.
 *
 * Callers must NOT write content with visibility >= 'org' when clean is false.
 */
export declare function scanForSecrets(content: string): ScanResult;
/**
 * Returns true when content is safe to promote to shared visibility (>= 'org').
 * Convenience wrapper around scanForSecrets.
 */
export declare function isSafeForSharedVisibility(content: string): boolean;
/**
 * Check whether a visibility level requires secret scanning.
 * Scanning is required for 'org', 'council', and 'fleet'.
 * 'private' content stays with the owner — no cross-agent risk.
 */
export declare function requiresScan(visibility: string): boolean;
//# sourceMappingURL=secret-scanner.d.ts.map