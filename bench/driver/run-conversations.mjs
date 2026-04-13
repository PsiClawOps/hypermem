#!/usr/bin/env node
/**
 * Benchmark conversation driver.
 * 
 * Connects to the bench OpenClaw gateway, replays a conversation dataset,
 * then asks recall questions. Captures responses, latencies, and metadata.
 * 
 * Usage: node run-conversations.mjs --out results/hypermem.json [--dataset locomo]
 */

import { BenchBridgeClient } from './bridge-client.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: 'results/output.json' },
    dataset: { type: 'string', default: 'locomo' },
    url: { type: 'string', default: 'ws://127.0.0.1:18790' },
    token: { type: 'string', default: 'bench-test-token-do-not-use-in-prod' },
    'delay-ms': { type: 'string', default: '500' }
  }
})

const DELAY_MS = parseInt(args['delay-ms'], 10)

async function loadDataset(name) {
  const datasetPath = path.join(import.meta.dirname, '..', 'dataset', name, 'conversations.json')
  if (!fs.existsSync(datasetPath)) {
    console.error(`Dataset not found: ${datasetPath}`)
    console.error('Run: node driver/fetch-locomo.mjs to download the LoCoMo dataset')
    process.exit(1)
  }
  return JSON.parse(fs.readFileSync(datasetPath, 'utf-8'))
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function main() {
  console.log(`[bench] Loading dataset: ${args.dataset}`)
  const dataset = await loadDataset(args.dataset)
  
  console.log(`[bench] Connecting to gateway: ${args.url}`)
  const client = new BenchBridgeClient({ url: args.url, token: args.token })
  await client.connect()
  console.log('[bench] Connected.')

  const results = {
    metadata: {
      dataset: args.dataset,
      timestamp: new Date().toISOString(),
      gatewayUrl: args.url,
      conversationCount: dataset.conversations?.length || 0,
      questionCount: dataset.questions?.length || 0
    },
    conversations: [],
    questions: [],
    summary: {}
  }

  // Phase 1: Replay conversations (build memory)
  console.log(`[bench] Phase 1: Replaying ${dataset.conversations?.length || 0} conversations...`)
  
  for (const convo of (dataset.conversations || [])) {
    const sessionKey = `bench:convo:${convo.id}`
    const convoResult = { id: convo.id, messages: [], totalLatency: 0 }
    
    for (const msg of convo.messages) {
      const { result, latency } = await client.sendMessage(sessionKey, msg.content)
      convoResult.messages.push({
        role: msg.role,
        content: msg.content,
        latency,
        responsePreview: typeof result === 'string' ? result.slice(0, 200) : JSON.stringify(result).slice(0, 200)
      })
      convoResult.totalLatency += latency
      await sleep(DELAY_MS) // avoid hammering
    }
    
    results.conversations.push(convoResult)
    console.log(`  [convo ${convo.id}] ${convo.messages.length} messages, ${Math.round(convoResult.totalLatency)}ms total`)
  }

  // Phase 2: Ask recall questions
  console.log(`\n[bench] Phase 2: Asking ${dataset.questions?.length || 0} recall questions...`)
  
  for (const q of (dataset.questions || [])) {
    const sessionKey = `bench:recall:${q.id}`
    const start = performance.now()
    const { result, latency } = await client.sendMessage(sessionKey, q.question)
    
    results.questions.push({
      id: q.id,
      type: q.type || 'unknown', // single-hop, multi-hop, temporal, open-domain
      question: q.question,
      expectedAnswer: q.answer,
      agentAnswer: typeof result === 'string' ? result : JSON.stringify(result),
      latency,
      conversationRefs: q.conversationRefs || []
    })
    
    console.log(`  [q ${q.id}] ${q.type || '?'} — ${Math.round(latency)}ms`)
    await sleep(DELAY_MS)
  }

  // Phase 3: Compute summary stats
  const latencies = results.questions.map(q => q.latency).sort((a, b) => a - b)
  results.summary = {
    totalConversations: results.conversations.length,
    totalQuestions: results.questions.length,
    latency: latencies.length > 0 ? {
      p50: latencies[Math.floor(latencies.length * 0.5)],
      p95: latencies[Math.floor(latencies.length * 0.95)],
      p99: latencies[Math.floor(latencies.length * 0.99)],
      mean: latencies.reduce((a, b) => a + b, 0) / latencies.length
    } : {},
    byType: {}
  }

  // Group by question type
  for (const q of results.questions) {
    const t = q.type || 'unknown'
    if (!results.summary.byType[t]) {
      results.summary.byType[t] = { count: 0, totalLatency: 0 }
    }
    results.summary.byType[t].count++
    results.summary.byType[t].totalLatency += q.latency
  }

  // Write results
  const outPath = path.resolve(args.out)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2))
  console.log(`\n[bench] Results written to ${outPath}`)
  console.log(`[bench] Summary: ${results.summary.totalQuestions} questions, p50=${Math.round(results.summary.latency?.p50 || 0)}ms, p95=${Math.round(results.summary.latency?.p95 || 0)}ms`)

  await client.close()
}

main().catch(err => {
  console.error('[bench] Fatal:', err)
  process.exit(1)
})
