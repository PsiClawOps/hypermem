import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const distPath = path.join(repoRoot, 'dist', 'index.js');
const fixturePath = path.join(repoRoot, 'test', 'fixtures', 'phase-c', 'degradation-fixtures.json');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.log(`  FAIL: ${msg}`);
    failed++;
  }
}

async function main() {
  console.log('===================================================');
  console.log('  HyperMem Phase C0.3: Canonical Degradation Fixtures');
  console.log('===================================================\n');

  if (!fs.existsSync(distPath)) {
    console.error('  dist not found. Run: npm run build');
    process.exit(1);
  }
  if (!fs.existsSync(fixturePath)) {
    console.error('  fixture file not found:', fixturePath);
    process.exit(1);
  }

  const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const mod = await import(`file://${distPath}?c0=${Date.now()}`);

  const {
    DEGRADATION_REASONS,
    DEGRADATION_LIMITS,
    formatToolChainStub,
    parseToolChainStub,
    isToolChainStub,
    formatArtifactRef,
    parseArtifactRef,
    isArtifactRef,
    formatReplayMarker,
    parseReplayMarker,
    isReplayMarker,
    isDegradedContent,
    isDegradationReason,
    isReplayState,
  } = mod;

  console.log('── Reason surface ──');
  assert(Array.isArray(DEGRADATION_REASONS), 'DEGRADATION_REASONS is an array');
  assert(new Set(DEGRADATION_REASONS).size === DEGRADATION_REASONS.length, 'DEGRADATION_REASONS has no duplicates');
  assert(JSON.stringify(DEGRADATION_REASONS) === JSON.stringify(fixtures.reasonSurface), 'fixture reason surface matches exported reason surface');
  assert(isDegradationReason('pressure_mismatch'), 'pressure_mismatch is part of the reason surface');
  assert(!isDegradationReason('bogus_reason'), 'bogus reason is rejected');

  console.log('\n── Canonical string fixtures ──');
  const toolStub = formatToolChainStub(fixtures.toolChainStub.input);
  assert(toolStub === fixtures.toolChainStub.expected, 'tool-chain stub format matches golden fixture');
  assert(isToolChainStub(toolStub), 'tool-chain stub is recognized');
  const parsedToolStub = parseToolChainStub(toolStub);
  assert(parsedToolStub !== null, 'tool-chain stub parses');
  assert(parsedToolStub?.reason === fixtures.toolChainStub.input.reason, 'tool-chain stub reason survives round-trip');
  assert(parsedToolStub?.summary === fixtures.toolChainStub.input.summary, 'tool-chain stub summary survives round-trip');
  assert(isDegradedContent(toolStub), 'tool-chain stub counts as degraded content');

  const artifactRef = formatArtifactRef(fixtures.artifactRef.input);
  assert(artifactRef === fixtures.artifactRef.expected, 'artifact reference format matches golden fixture');
  assert(isArtifactRef(artifactRef), 'artifact reference is recognized');
  const parsedArtifactRef = parseArtifactRef(artifactRef);
  assert(parsedArtifactRef !== null, 'artifact reference parses');
  assert(parsedArtifactRef?.reason === fixtures.artifactRef.input.reason, 'artifact reference reason survives round-trip');
  assert(parsedArtifactRef?.fetchHint === fixtures.artifactRef.input.fetchHint, 'artifact reference fetch hint survives round-trip');
  assert(isDegradedContent(artifactRef), 'artifact reference counts as degraded content');

  for (const markerFixture of fixtures.replayMarkers) {
    const replayMarker = formatReplayMarker(markerFixture.input);
    assert(replayMarker === markerFixture.expected, `replay marker format matches golden fixture (${markerFixture.input.state})`);
    assert(isReplayMarker(replayMarker), `replay marker is recognized (${markerFixture.input.state})`);
    const parsedReplay = parseReplayMarker(replayMarker);
    assert(parsedReplay !== null, `replay marker parses (${markerFixture.input.state})`);
    assert(parsedReplay?.reason === markerFixture.input.reason, `replay marker reason survives round-trip (${markerFixture.input.state})`);
    assert(parsedReplay?.summary === markerFixture.input.summary, `replay marker summary survives round-trip (${markerFixture.input.state})`);
    assert(isDegradedContent(replayMarker), `replay marker counts as degraded content (${markerFixture.input.state})`);
  }

  console.log('\n── Boundedness checks ──');
  const longTool = formatToolChainStub({
    name: 'web_search',
    id: 'hm_tool_long',
    status: 'ejected',
    reason: 'gradient_t3_stub',
    summary: 'First line]\n' + 'x'.repeat(400),
  });
  const longToolParsed = parseToolChainStub(longTool);
  assert(longToolParsed !== null, 'long tool-chain stub parses');
  assert(longToolParsed?.summary.length <= DEGRADATION_LIMITS.toolSummary, `tool summary stays within cap (${longToolParsed?.summary.length} <= ${DEGRADATION_LIMITS.toolSummary})`);
  assert(!longTool.includes('\n'), 'tool-chain stub flattens newlines');
  assert(longToolParsed?.summary.startsWith('First line)'), 'tool-chain stub sanitizes closing brackets');

  const longArtifact = formatArtifactRef({
    id: 'artifact-long',
    path: '/artifact/' + 'segment/'.repeat(40) + 'file.md',
    sizeTokens: 24000,
    status: 'degraded',
    reason: 'artifact_oversize',
    fetchHint: 'memory_search ' + 'again '.repeat(20),
  });
  const longArtifactParsed = parseArtifactRef(longArtifact);
  assert(longArtifactParsed !== null, 'long artifact reference parses');
  assert(longArtifactParsed?.path.length <= DEGRADATION_LIMITS.artifactPath, `artifact path stays within cap (${longArtifactParsed?.path.length} <= ${DEGRADATION_LIMITS.artifactPath})`);
  assert(longArtifactParsed?.fetchHint.length <= DEGRADATION_LIMITS.artifactFetchHint, `artifact fetch hint stays within cap (${longArtifactParsed?.fetchHint.length} <= ${DEGRADATION_LIMITS.artifactFetchHint})`);

  const longReplay = formatReplayMarker({
    state: 'stabilizing',
    status: 'bounded',
    reason: 'replay_stabilizing',
    summary: 'recovery mode]' + 'y'.repeat(400),
  });
  const longReplayParsed = parseReplayMarker(longReplay);
  assert(longReplayParsed !== null, 'long replay marker parses');
  assert(longReplayParsed?.summary.length <= DEGRADATION_LIMITS.replaySummary, `replay summary stays within cap (${longReplayParsed?.summary.length} <= ${DEGRADATION_LIMITS.replaySummary})`);
  assert(isReplayState(longReplayParsed?.state ?? ''), 'replay state validator accepts canonical state');

  console.log('\n── Negative samples ──');
  assert(parseToolChainStub('[tool:read id=hm_1 status=ejected reason=bogus summary=bad]') === null, 'invalid tool-chain reason is rejected');
  assert(parseArtifactRef('[artifact:doc-1 path=/x size=1 status=degraded reason=bogus fetch=memory_search]') === null, 'invalid artifact reason is rejected');
  assert(parseReplayMarker('[replay state=entering status=bounded reason=bogus summary=ok]') === null, 'invalid replay reason is rejected');

  console.log('\n═══════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ALL ${passed} TESTS PASSED ✅`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED ❌`);
  }
  console.log('═══════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Phase C fixture test failed:', err);
  process.exit(1);
});
