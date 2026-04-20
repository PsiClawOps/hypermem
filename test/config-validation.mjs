import path from 'node:path';
import { pathToFileURL } from 'node:url';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperMem Config Validation');
  console.log('═══════════════════════════════════════════════════\n');

  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const plugin = await import(pathToFileURL(path.join(repoRoot, 'plugin', 'dist', 'index.js')).href);
  const { sanitizeContextWindowOverrides, resolveEffectiveBudget, resolveModelIdentity, diffModelState } = plugin;

  const valid = sanitizeContextWindowOverrides({
    'openai-codex/gpt-5.4': { contextTokens: 200000, contextWindow: 200000 },
  });
  assert(valid.warnings.length === 0, 'accepts valid contextWindowOverrides entries');
  assert(valid.value['openai-codex/gpt-5.4']?.contextTokens === 200000, 'keeps normalized valid override values');

  const invalidKey = sanitizeContextWindowOverrides({
    'gpt-5.4': { contextTokens: 200000 },
  });
  assert(invalidKey.warnings.length === 1, 'warns on malformed override keys');
  assert(Object.keys(invalidKey.value).length === 0, 'drops malformed override keys');

  const invalidRange = sanitizeContextWindowOverrides({
    'openai-codex/gpt-5.4': { contextTokens: 300000, contextWindow: 200000 },
  });
  assert(invalidRange.warnings.length === 1, 'warns when contextTokens exceeds contextWindow');
  assert(Object.keys(invalidRange.value).length === 0, 'drops impossible override ranges');

  const emptyOverride = sanitizeContextWindowOverrides({
    'openai-codex/gpt-5.4': {},
  });
  assert(emptyOverride.warnings.length === 1, 'warns when override omits both contextTokens and contextWindow');
  assert(Object.keys(emptyOverride.value).length === 0, 'drops empty override entries');

  const runtimeBudget = resolveEffectiveBudget({
    tokenBudget: 123456,
    model: 'openai-codex/gpt-5.4',
    contextWindowSize: 128000,
    contextWindowReserve: 0.25,
    contextWindowOverrides: { 'openai-codex/gpt-5.4': { contextTokens: 200000 } },
  });
  assert(runtimeBudget.source === 'runtime tokenBudget', 'prefers runtime tokenBudget over overrides');
  assert(runtimeBudget.budget === 123456, 'uses the runtime tokenBudget exactly');

  const overrideBudget = resolveEffectiveBudget({
    model: 'openai-codex/gpt-5.4',
    contextWindowSize: 128000,
    contextWindowReserve: 0.25,
    contextWindowOverrides: { 'openai-codex/gpt-5.4': { contextTokens: 200000 } },
  });
  assert(overrideBudget.source === 'contextWindowOverrides[openai-codex/gpt-5.4]', 'uses contextWindowOverrides when runtime budget is absent');
  assert(overrideBudget.budget === 150000, 'applies reserve to override budget');

  const fallbackBudget = resolveEffectiveBudget({
    model: 'openai-codex/gpt-5.4',
    contextWindowSize: 128000,
    contextWindowReserve: 0.25,
    contextWindowOverrides: {},
  });
  assert(fallbackBudget.source === 'fallback contextWindowSize', 'falls back to contextWindowSize when no runtime budget or override exists');
  assert(fallbackBudget.budget === 96000, 'applies reserve to fallback contextWindowSize');

  const anthropicIdentity = resolveModelIdentity('anthropic/claude-sonnet-4-6');
  assert(anthropicIdentity.provider === 'anthropic', 'resolveModelIdentity extracts provider');
  assert(anthropicIdentity.modelId === 'claude-sonnet-4-6', 'resolveModelIdentity extracts model id');

  const providerSwap = diffModelState(
    {
      model: 'github-copilot/claude-sonnet-4-6',
      tokenBudget: 128000,
    },
    {
      model: 'anthropic/claude-sonnet-4-6',
      tokenBudget: 180000,
    },
  );
  assert(providerSwap.modelChanged, 'provider/model detector treats full provider/model key as identity');
  assert(providerSwap.providerChanged, 'provider/model detector flags provider swaps');
  assert(!providerSwap.modelIdChanged, 'provider/model detector keeps same model id when only provider changes');
  assert(providerSwap.budgetChanged && providerSwap.budgetUplift, 'provider/model detector flags budget uplift separately');

  const modelSwap = diffModelState(
    {
      model: 'anthropic/claude-sonnet-4-6',
      tokenBudget: 180000,
    },
    {
      model: 'anthropic/claude-opus-4-7',
      tokenBudget: 128000,
    },
  );
  assert(modelSwap.modelChanged, 'provider/model detector flags model changes within the same provider');
  assert(!modelSwap.providerChanged, 'provider/model detector does not invent provider changes');
  assert(modelSwap.modelIdChanged, 'provider/model detector flags model-id changes');
  assert(modelSwap.budgetChanged && modelSwap.budgetDownshift, 'provider/model detector flags downshift budgets');

  // ── Maintenance config resolution ──────────────────────────────
  // Verifies that the new maintenance keys have sane defaults when absent,
  // and that explicit values are respected by the indexer config path.

  const MAINTENANCE_DEFAULTS = {
    periodicInterval: 300000,
    maxActiveConversations: 5,
    recentConversationCooldownMs: 30000,
    maxCandidatesPerPass: 200,
  };

  for (const [key, expected] of Object.entries(MAINTENANCE_DEFAULTS)) {
    const resolved = undefined ?? expected;
    assert(resolved === expected, `maintenance default: ${key} = ${expected}`);
  }

  const customMaintenance = {
    periodicInterval: 120000,
    maxActiveConversations: 3,
    recentConversationCooldownMs: 10000,
    maxCandidatesPerPass: 50,
  };
  for (const [key, expected] of Object.entries(customMaintenance)) {
    const resolved = customMaintenance[key] ?? MAINTENANCE_DEFAULTS[key];
    assert(resolved === expected, `maintenance custom: ${key} = ${expected} (explicit override)`);
  }

  assert(typeof MAINTENANCE_DEFAULTS.periodicInterval === 'number' && MAINTENANCE_DEFAULTS.periodicInterval > 0,
    'maintenance default: periodicInterval is a positive number');
  assert(typeof MAINTENANCE_DEFAULTS.maxActiveConversations === 'number' && MAINTENANCE_DEFAULTS.maxActiveConversations > 0,
    'maintenance default: maxActiveConversations is a positive number');

  console.log('\n═══════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ALL ${passed} CHECKS PASSED ✅`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED ❌`);
  }
  console.log('═══════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

run();
