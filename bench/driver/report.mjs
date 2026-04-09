#!/usr/bin/env node
/**
 * Generate comparison report from scored benchmark results.
 * 
 * Usage: node report.mjs --results-dir results/ --out results/comparison.md
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    'results-dir': { type: 'string', default: 'results' },
    out: { type: 'string', default: 'results/comparison.md' }
  }
})

const resultsDir = path.resolve(args['results-dir'])

// Load all scored result files
const runs = []
for (const f of fs.readdirSync(resultsDir)) {
  if (!f.endsWith('.json') || f.includes('summary') || f.includes('comparison')) continue
  try {
    const data = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf-8'))
    if (data.scores) {
      runs.push({ name: f.replace('.json', ''), ...data })
    }
  } catch (e) {
    // skip
  }
}

if (runs.length === 0) {
  console.error('[report] No scored results found')
  process.exit(1)
}

// Sort by F1 descending
runs.sort((a, b) => (b.scores.f1_mean || 0) - (a.scores.f1_mean || 0))

// Generate markdown
let md = `# HyperMem Benchmark Results

**Generated:** ${new Date().toISOString()}
**Dataset:** ${runs[0].metadata?.dataset || 'unknown'}
**Methodology:** Sequential A/B on identical OpenClaw stacks. Only the memory hook differs.

## Overall Results

| Memory System | F1 | BLEU-1 | Latency p50 | Latency p95 | Questions |
|---|---|---|---|---|---|
`

for (const r of runs) {
  const s = r.scores
  md += `| **${r.name}** | ${(s.f1_mean * 100).toFixed(1)}% | ${(s.bleu1_mean * 100).toFixed(1)}% | ${Math.round(s.latency_p50)}ms | ${Math.round(s.latency_p95)}ms | ${s.questionCount} |\n`
}

// By question type
const allTypes = new Set()
for (const r of runs) {
  for (const t of Object.keys(r.scores.byType || {})) allTypes.add(t)
}

if (allTypes.size > 0) {
  md += `\n## By Question Type\n`
  
  for (const type of [...allTypes].sort()) {
    md += `\n### ${type}\n\n`
    md += `| Memory System | F1 | BLEU-1 | Avg Latency | Count |\n`
    md += `|---|---|---|---|---|\n`
    
    for (const r of runs) {
      const s = r.scores.byType?.[type]
      if (s) {
        md += `| **${r.name}** | ${(s.f1_mean * 100).toFixed(1)}% | ${(s.bleu1_mean * 100).toFixed(1)}% | ${Math.round(s.latency_mean)}ms | ${s.count} |\n`
      } else {
        md += `| **${r.name}** | — | — | — | 0 |\n`
      }
    }
  }
}

// Winner summary
if (runs.length > 1) {
  md += `\n## Summary\n\n`
  md += `**Best F1:** ${runs[0].name} (${(runs[0].scores.f1_mean * 100).toFixed(1)}%)\n\n`
  
  const byLatency = [...runs].sort((a, b) => (a.scores.latency_p50 || Infinity) - (b.scores.latency_p50 || Infinity))
  md += `**Lowest latency (p50):** ${byLatency[0].name} (${Math.round(byLatency[0].scores.latency_p50)}ms)\n\n`
  
  md += `> These results compare memory systems on identical OpenClaw stacks.\n`
  md += `> The only variable is the memory hook. Same model, same prompt, same hardware.\n`
}

const outPath = path.resolve(args.out)
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, md)
console.log(`[report] Comparison written to ${outPath}`)
console.log(md)
