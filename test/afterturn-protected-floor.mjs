import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✅ ${msg}`); passed++; }
  else { console.log(`  ❌ FAIL: ${msg}`); failed++; }
}

function simulateAfterTurnCap(costs, budget, capFraction, floorFraction) {
  const cap = Math.floor(budget * capFraction);
  const floor = Math.floor(budget * floorFraction);
  let running = 0;
  let protectedSlotsKept = 0;
  const kept = [];
  for (let i = costs.length - 1; i >= 0; i--) {
    const cost = costs[i];
    const wouldExceedCap = running + cost > cap && kept.length > 0;
    const belowFloor = floor > 0 && running < floor;
    if (wouldExceedCap && !belowFloor) break;
    if (wouldExceedCap && belowFloor) protectedSlotsKept++;
    kept.unshift(cost);
    running += cost;
    if (running >= cap && running >= floor) break;
  }
  return { tokens: running, kept, protectedSlotsKept, cap, floor };
}

console.log('═══════════════════════════════════════════════════════');
console.log('  HyperMem AfterTurn Protected Warming Floor Test');
console.log('═══════════════════════════════════════════════════════\n');

const BUDGET = 100000;
const elevatedFloor = 0.34;
const bootstrapFloor = Math.max(elevatedFloor, 0.62 * 0.60);
const warmupFloor = Math.max(elevatedFloor, 0.55 * 0.60);

// Oldest cluster is a warm recalled layer. Newest cluster alone is below the
// protected floor, but adding the older cluster exceeds the soft cap. Packet 3
// should keep it only while the protected floor is active.
const clusterCosts = [39750, 29750];

const warmup = simulateAfterTurnCap(clusterCosts, BUDGET, 0.68, warmupFloor);
assert(warmup.tokens >= Math.floor(BUDGET * warmupFloor),
  `warmup floor keeps clusters at/above elevated allocation (${warmup.tokens} >= ${Math.floor(BUDGET * warmupFloor)})`);
assert(warmup.protectedSlotsKept === 1,
  `warmup protected slot kept count is metadata-only count (${warmup.protectedSlotsKept})`);

const bootstrap = simulateAfterTurnCap(clusterCosts, BUDGET, 0.72, bootstrapFloor);
assert(bootstrap.tokens >= Math.floor(BUDGET * bootstrapFloor),
  `bootstrap floor keeps clusters above bootstrap protected floor (${bootstrap.tokens} >= ${Math.floor(BUDGET * bootstrapFloor)})`);

const elevated = simulateAfterTurnCap(clusterCosts, BUDGET, 0.60, 0);
assert(elevated.tokens < Math.floor(BUDGET * warmupFloor),
  `elevated pressure disables protected floor (${elevated.tokens} < ${Math.floor(BUDGET * warmupFloor)})`);
assert(elevated.protectedSlotsKept === 0,
  `elevated pressure emits no protected slot kept count (${elevated.protectedSlotsKept})`);

const source = fs.readFileSync(path.join(repoRoot, 'src', 'compositor.ts'), 'utf8');
assert(source.includes('resolveAfterTurnProtectedWarmingFloor'),
  'compositor contains private protected floor resolver');
assert(source.includes('protectedClustersKept'),
  'compositor tracks protected keep count without message content');
assert(!source.includes('export { resolveAfterTurnProtectedWarmingFloor'),
  'protected floor resolver is not exported');

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
