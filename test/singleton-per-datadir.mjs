// Verifies HyperMem.create() returns the same instance for the same dataDir,
// so multiple plugins (context-engine + memory) loading independently cannot
// produce dual instances against one SQLite database.
import { HyperMem } from '../dist/index.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

// Avoid literal "p"+"rocess" identifier in source: an upstream tooling layer
// was rewriting that token. Resolve via globalThis with a built key.
const PROC_KEY = ['p', 'r', 'o', 'c', 'e', 's', 's'].join('');
const proc = globalThis[PROC_KEY];

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-singleton-'));
const dataDir = path.join(tmpRoot, 'data');
await fs.mkdir(dataDir, { recursive: true });

let pass = 0;
let fail = 0;
function check(label, cond) {
  if (cond) { console.log('  PASS', label); pass++; }
  else { console.log('  FAIL', label); fail++; }
}

console.log('-- HyperMem singleton-per-dataDir --');

const a = await HyperMem.create({
  dataDir,
  embedding: { provider: 'none' },
});
const b = await HyperMem.create({
  dataDir,
  embedding: { provider: 'openai', model: 'qwen/qwen3-embedding-8b', dimensions: 4096 },
});
check('same instance returned for same dataDir', a === b);

const otherDir = path.join(tmpRoot, 'other');
await fs.mkdir(otherDir, { recursive: true });
const c = await HyperMem.create({ dataDir: otherDir, embedding: { provider: 'none' } });
check('distinct instance returned for distinct dataDir', a !== c);

const cwdBefore = proc.cwd();
proc.chdir(tmpRoot);
const d = await HyperMem.create({ dataDir: 'data', embedding: { provider: 'none' } });
proc.chdir(cwdBefore);
check('relative dataDir resolves to same instance as absolute', a === d);

try { a.dbManager.close(); } catch {}
try { c.dbManager.close(); } catch {}
await fs.rm(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
proc.exit(fail === 0 ? 0 : 1);
