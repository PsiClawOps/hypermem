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
const RULES = [
    // ── API Keys ──────────────────────────────────────────────
    {
        id: 'anthropic-api-key',
        description: 'Anthropic API key',
        pattern: /\bsk-ant-[a-zA-Z0-9\-_]{20,}\b/g,
    },
    {
        id: 'openai-api-key',
        description: 'OpenAI API key',
        pattern: /\bsk-[a-zA-Z0-9\-_]{20,}\b/g,
    },
    {
        id: 'openai-org-id',
        description: 'OpenAI organization ID',
        pattern: /\borg-[a-zA-Z0-9]{16,}\b/g,
    },
    {
        id: 'github-pat-classic',
        description: 'GitHub personal access token (classic)',
        pattern: /\bghp_[a-zA-Z0-9]{36}\b/g,
    },
    {
        id: 'github-pat-fine',
        description: 'GitHub fine-grained personal access token',
        pattern: /\bgithub_pat_[a-zA-Z0-9_]{82}\b/g,
    },
    {
        id: 'github-oauth-token',
        description: 'GitHub OAuth token',
        pattern: /\bgho_[a-zA-Z0-9]{36}\b/g,
    },
    {
        id: 'github-app-token',
        description: 'GitHub App installation token',
        pattern: /\bghs_[a-zA-Z0-9]{36}\b/g,
    },
    {
        id: 'github-refresh-token',
        description: 'GitHub refresh token',
        pattern: /\bghr_[a-zA-Z0-9]{76}\b/g,
    },
    {
        id: 'aws-access-key',
        description: 'AWS access key ID',
        pattern: /\b(A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g,
    },
    {
        id: 'aws-secret-key',
        description: 'AWS secret access key (heuristic)',
        pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)["\s:=]+([A-Za-z0-9\/+]{40})\b/gi,
    },
    {
        id: 'google-api-key',
        description: 'Google API key',
        pattern: /\bAIza[0-9A-Za-z_\-]{35}\b/g,
    },
    {
        id: 'google-oauth',
        description: 'Google OAuth client secret',
        pattern: /\bGOCSPX-[0-9A-Za-z_\-]{28}\b/g,
    },
    {
        id: 'slack-token',
        description: 'Slack API token',
        pattern: /\bxox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,32}\b/g,
    },
    {
        id: 'slack-webhook',
        description: 'Slack incoming webhook URL',
        pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]{9,11}\/[A-Z0-9]{9,11}\/[a-zA-Z0-9]{24}/g,
    },
    {
        id: 'discord-token',
        description: 'Discord bot token',
        pattern: /\b[MNO][a-zA-Z0-9]{23}\.[a-zA-Z0-9_\-]{6}\.[a-zA-Z0-9_\-]{27}\b/g,
    },
    {
        id: 'discord-webhook',
        description: 'Discord webhook URL',
        pattern: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/[0-9]{17,19}\/[a-zA-Z0-9_\-]{68}/g,
    },
    {
        id: 'stripe-key',
        description: 'Stripe API key',
        pattern: /\b(?:sk|pk|rk)_(?:live|test)_[a-zA-Z0-9]{24,99}\b/g,
    },
    {
        id: 'sendgrid-key',
        description: 'SendGrid API key',
        pattern: /\bSG\.[a-zA-Z0-9\-_]{22,}\.[a-zA-Z0-9\-_]{43,}\b/g,
    },
    {
        id: 'twilio-account-sid',
        description: 'Twilio Account SID',
        pattern: /\bAC[0-9a-fA-F]{32}\b/g,
    },
    {
        id: 'twilio-auth-token',
        description: 'Twilio Auth Token (heuristic)',
        pattern: /(?:twilio[_\s\-]*(?:auth[_\s\-]*)?token)["\s:=]+([0-9a-f]{32})\b/gi,
    },
    // ── Private Keys / Certificates ───────────────────────────
    {
        id: 'pem-private-key',
        description: 'PEM private key block',
        pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,
    },
    {
        id: 'pem-certificate',
        description: 'PEM certificate (may contain private data)',
        pattern: /-----BEGIN CERTIFICATE-----/g,
    },
    // ── Passwords in common config patterns ───────────────────
    {
        id: 'password-assignment',
        description: 'Password in config-like assignment',
        // Matches: password=<value>, "password": "<value>", PASSWORD=<value>
        pattern: /(?:^|[,{;\n])\s*(?:password|passwd|secret|token|api_key|apikey|api-key|access_token|auth_token|client_secret)\s*[=:]\s*["']([^"'\n]{8,})["']/gim,
        minEntropy: 2.5,
    },
    // ── Database connection strings ────────────────────────────
    {
        id: 'db-connection-string',
        description: 'Database connection string with credentials',
        pattern: /(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^:]+:[^@]{6,}@/gi,
    },
    // ── Bearer tokens ─────────────────────────────────────────
    {
        id: 'bearer-token-header',
        description: 'Bearer token in Authorization header value',
        pattern: /Authorization[:\s]+Bearer\s+([a-zA-Z0-9\-_=.]{20,})/gi,
    },
    // ── JWT ───────────────────────────────────────────────────
    {
        id: 'jwt-token',
        description: 'JSON Web Token',
        pattern: /\beyJ[a-zA-Z0-9\-_]+\.eyJ[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\b/g,
        minEntropy: 3.0,
    },
    // ── OpenClaw-specific ──────────────────────────────────────
    {
        id: 'openclaw-api-key',
        description: 'OpenClaw API key',
        pattern: /\boc_[a-zA-Z0-9\-_]{24,}\b/g,
    },
];
// ─── Entropy Calculation ─────────────────────────────────────────
/**
 * Calculate Shannon entropy of a string (bits per character, base 2).
 * Used to filter out low-entropy false positives like "password=example".
 */
function shannonEntropy(s) {
    if (s.length === 0)
        return 0;
    const freq = new Map();
    for (const ch of s) {
        freq.set(ch, (freq.get(ch) || 0) + 1);
    }
    let entropy = 0;
    for (const count of freq.values()) {
        const p = count / s.length;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}
// ─── Redaction ───────────────────────────────────────────────────
/**
 * Redact a matched value: show first 3 and last 3 characters, mask the middle.
 */
function redact(value) {
    if (value.length <= 8)
        return '[REDACTED]';
    const prefix = value.slice(0, 3);
    const suffix = value.slice(-3);
    const masked = '*'.repeat(Math.min(value.length - 6, 20));
    return `${prefix}${masked}${suffix}`;
}
// ─── Public API ──────────────────────────────────────────────────
/**
 * Scan content for secrets before promoting to shared visibility.
 *
 * Returns { clean: true } when no secrets found.
 * Returns { clean: false, hits } when secrets are detected.
 *
 * Callers must NOT write content with visibility >= 'org' when clean is false.
 */
export function scanForSecrets(content) {
    const hits = [];
    for (const rule of RULES) {
        // Reset lastIndex for global regexes
        rule.pattern.lastIndex = 0;
        let match;
        while ((match = rule.pattern.exec(content)) !== null) {
            const matched = match[1] ?? match[0]; // prefer capture group 1 if present
            // Entropy filter
            if (rule.minEntropy && shannonEntropy(matched) < rule.minEntropy) {
                continue;
            }
            hits.push({
                rule: rule.id,
                description: rule.description,
                redactedMatch: redact(matched),
                offset: match.index,
            });
            // Cap at 10 hits per content to avoid O(n²) explosion on adversarial input
            if (hits.length >= 10)
                break;
        }
        if (hits.length >= 10)
            break;
    }
    return { clean: hits.length === 0, hits };
}
/**
 * Returns true when content is safe to promote to shared visibility (>= 'org').
 * Convenience wrapper around scanForSecrets.
 */
export function isSafeForSharedVisibility(content) {
    return scanForSecrets(content).clean;
}
/**
 * Check whether a visibility level requires secret scanning.
 * Scanning is required for 'org', 'council', and 'fleet'.
 * 'private' content stays with the owner — no cross-agent risk.
 */
export function requiresScan(visibility) {
    return visibility === 'org' || visibility === 'council' || visibility === 'fleet';
}
//# sourceMappingURL=secret-scanner.js.map