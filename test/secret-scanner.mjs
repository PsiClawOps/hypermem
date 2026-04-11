/**
 * Secret Scanner Tests
 *
 * Validates detection of common secret patterns and correct
 * enforcement at the episode-store boundary.
 */

import { scanForSecrets, isSafeForSharedVisibility, requiresScan } from '../dist/secret-scanner.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
    // Print extra context on failure
    console.error(`     → assertion failed`);
  }
}

function assertHit(content, expectedRule, msg) {
  const result = scanForSecrets(content);
  const hit = result.hits.find(h => h.rule === expectedRule);
  if (!result.clean && hit) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg} — clean=${result.clean}, hits=[${result.hits.map(h => h.rule).join(', ')}]`);
    failed++;
  }
}

// ─── requiresScan ───────────────────────────────────────────────
console.log('\n─── requiresScan ───');
assert(requiresScan('org'), 'org requires scan');
assert(requiresScan('council'), 'council requires scan');
assert(requiresScan('fleet'), 'fleet requires scan');
assert(!requiresScan('private'), 'private does not require scan');

// ─── Clean content ─────────────────────────────────────────────
console.log('\n─── Clean content ───');
assert(isSafeForSharedVisibility(''), 'empty string is clean');
assert(isSafeForSharedVisibility('Completed the Memory Engine migration today'), 'normal text is clean');
assert(isSafeForSharedVisibility('password=example_password_here'), 'low-entropy password is clean (skip)');
assert(isSafeForSharedVisibility('https://example.com/webhook/callback'), 'normal URL is clean');

// ─── Anthropic API key ─────────────────────────────────────────
console.log('\n─── Anthropic API key ───');
assertHit(
  'Using sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMNOPQRSTUVWX to call the API',
  'anthropic-api-key',
  'Anthropic API key detected'
);
assert(isSafeForSharedVisibility('my anthropic key prefix is sk-ant'), 'truncated anthropic prefix is clean');

// ─── OpenAI API key ────────────────────────────────────────────
console.log('\n─── OpenAI API key ───');
assertHit(
  'Set OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 in your env',
  'openai-api-key',
  'OpenAI API key detected'
);

// ─── GitHub PAT ────────────────────────────────────────────────
console.log('\n─── GitHub PAT ───');
assertHit(
  'export GH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
  'github-pat-classic',
  'GitHub classic PAT detected'
);

// ─── AWS access key ────────────────────────────────────────────
console.log('\n─── AWS access key ───');
assertHit(
  'AWS access key: AKIAIOSFODNN7EXAMPLE is the example from docs',
  'aws-access-key',
  'AWS access key ID detected'
);

// ─── PEM private key ───────────────────────────────────────────
console.log('\n─── PEM private key ───');
assertHit(
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----',
  'pem-private-key',
  'PEM private key detected'
);
assertHit(
  '-----BEGIN PRIVATE KEY-----\nbase64data\n-----END PRIVATE KEY-----',
  'pem-private-key',
  'PEM PRIVATE KEY (PKCS8) detected'
);

// ─── JWT token ─────────────────────────────────────────────────
console.log('\n─── JWT token ───');
// Real JWT-shaped token
assertHit(
  'Authorization header contained: eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzEyMyIsImlhdCI6MTY4MDAwMDAwMCwiZXhwIjoxNjgwMDg2NDAwfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  'jwt-token',
  'JWT token detected'
);

// ─── Stripe key ────────────────────────────────────────────────
console.log('\n─── Stripe key ───');
assertHit(
  'stripe secret key: sk_live_51ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn',
  'stripe-key',
  'Stripe live secret key detected'
);

// ─── Slack token ───────────────────────────────────────────────
console.log('\n─── Slack token ───');
assertHit(
  'Bot token: xoxb-17653672481-19874698323-ABCDEFGHIJKLMNOPQRSTUVWXYZabc',
  'slack-token',
  'Slack bot token detected'
);

// ─── Discord webhook ───────────────────────────────────────────
console.log('\n─── Discord webhook ───');
assertHit(
  'webhook: https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrst',
  'discord-webhook',
  'Discord webhook detected'
);

// ─── DB connection string ──────────────────────────────────────
console.log('\n─── DB connection string ───');
assertHit(
  'DATABASE_URL=postgres://myuser:supersecretpassword@prod.db.internal:5432/mydb',
  'db-connection-string',
  'PostgreSQL connection string with credentials detected'
);

// ─── Multi-hit ─────────────────────────────────────────────────
console.log('\n─── Multi-hit content ───');
const multi = `
Here are the keys from the .env file:
OPENAI_API_KEY=sk-proj-abcdef1234567890abcdef1234567890abcdef12345678
ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
`;
const multiResult = scanForSecrets(multi);
assert(!multiResult.clean, 'multi-key content flagged as not clean');
assert(multiResult.hits.length >= 2, `at least 2 hits for multi-key (got ${multiResult.hits.length})`);

// ─── Hit cap ───────────────────────────────────────────────────
console.log('\n─── Hit cap (max 10) ───');
// Build content with many keys
const manyKeys = Array.from({ length: 15 }, (_, i) =>
  `TOKEN_${i}=sk-proj-${i.toString().padStart(4,'0')}abcdefghijklmnopqrstuvwxyz1234567890`
).join('\n');
const capResult = scanForSecrets(manyKeys);
assert(!capResult.clean, 'many-key content flagged as dirty');
assert(capResult.hits.length <= 10, `hit count capped at 10 (got ${capResult.hits.length})`);

// ─── Summary ───────────────────────────────────────────────────
console.log(`\n═══ SecretScanner: ${passed} passed, ${failed} failed ═══\n`);
if (failed > 0) process.exit(1);
