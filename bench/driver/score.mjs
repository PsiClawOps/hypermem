#!/usr/bin/env node
/**
 * Score benchmark results.
 * Computes F1, BLEU-1, and latency stats for each run.
 * LLM-as-Judge (J score) is optional — requires an API key.
 * 
 * Usage: node score.mjs --results-dir results/
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    'results-dir': { type: 'string', default: 'results' }
  }
})

// --- Scoring functions ---

function tokenize(text) {
  return (text || '').toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean)
}

function f1Score(predicted, reference) {
  const predTokens = new Set(tokenize(predicted))
  const refTokens = new Set(tokenize(reference))
  
  if (predTokens.size === 0 && refTokens.size === 0) return 1.0
  if (predTokens.size === 0 || refTokens.size === 0) return 0.0
  
  const overlap = [...predTokens].filter(t => refTokens.has(t)).length
  const precision = overlap / predTokens.size
  const recall = overlap / refTokens.size
  
  if (precision + recall === 0) return 0.0
  return (2 * precision * recall) / (precision + recall)
}

function bleu1(predicted, reference) {
  const predTokens = tokenize(predicted)
  const refTokens = tokenize(reference)
  
  if (predTokens.length === 0) return 0.0
  
  // Count reference token frequencies
  const refFreq = {}
  for (const t of refTokens) refFreq[t] = (refFreq[t] || 0) + 1
  
  // Count clipped matches
  const predFreq = {}
  for (const t of predTokens) predFreq[t] = (predFreq[t] || 0) + 1
  
  let clipped = 0
  for (const [t, count] of Object.entries(predFreq)) {
    clipped += Math.min(count, refFreq[t] || 0)
  }
  
  return clipped / predTokens.length
}

// --- Main ---

function scoreRun(resultFile) {
  const data = JSON.parse(fs.readFileSync(resultFile, 'utf-8'))
  
  if (!data.questions || data.questions.length === 0) {
    return { file: resultFile, error: 'No questions found', scores: {} }
  }
  
  const scores = {
    f1: [],
    bleu1: [],
    latency: [],
    byType: {}
  }
  
  for (const q of data.questions) {
    const f1 = f1Score(q.agentAnswer, q.expectedAnswer)
    const b1 = bleu1(q.agentAnswer, q.expectedAnswer)
    
    scores.f1.push(f1)
    scores.bleu1.push(b1)
    scores.latency.push(q.latency)
    
    const t = q.type || 'unknown'
    if (!scores.byType[t]) {
      scores.byType[t] = { f1: [], bleu1: [], latency: [], count: 0 }
    }
    scores.byType[t].f1.push(f1)
    scores.byType[t].bleu1.push(b1)
    scores.byType[t].latency.push(q.latency)
    scores.byType[t].count++
    
    // Annotate the question with scores
    q.scores = { f1, bleu1: b1 }
  }
  
  const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
  const percentile = (arr, p) => {
    const sorted = [...arr].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length * p)] || 0
  }
  
  data.scores = {
    f1_mean: mean(scores.f1),
    bleu1_mean: mean(scores.bleu1),
    latency_p50: percentile(scores.latency, 0.5),
    latency_p95: percentile(scores.latency, 0.95),
    latency_mean: mean(scores.latency),
    questionCount: data.questions.length,
    byType: {}
  }
  
  for (const [t, s] of Object.entries(scores.byType)) {
    data.scores.byType[t] = {
      f1_mean: mean(s.f1),
      bleu1_mean: mean(s.bleu1),
      latency_mean: mean(s.latency),
      count: s.count
    }
  }
  
  // Write scored results back
  fs.writeFileSync(resultFile, JSON.stringify(data, null, 2))
  
  return { file: path.basename(resultFile), scores: data.scores }
}

// Find and score all result files
const resultsDir = path.resolve(args['results-dir'])
const resultFiles = fs.readdirSync(resultsDir)
  .filter(f => f.endsWith('.json') && !f.includes('scored') && !f.includes('comparison'))
  .map(f => path.join(resultsDir, f))

console.log(`[score] Found ${resultFiles.length} result files to score`)

const allScores = []
for (const f of resultFiles) {
  console.log(`[score] Scoring ${path.basename(f)}...`)
  const result = scoreRun(f)
  allScores.push(result)
  if (result.scores.f1_mean !== undefined) {
    console.log(`  F1: ${(result.scores.f1_mean * 100).toFixed(1)}%  BLEU-1: ${(result.scores.bleu1_mean * 100).toFixed(1)}%  Latency p50: ${Math.round(result.scores.latency_p50)}ms`)
  }
}

// Write summary
const summaryPath = path.join(resultsDir, 'scores-summary.json')
fs.writeFileSync(summaryPath, JSON.stringify(allScores, null, 2))
console.log(`[score] Summary written to ${summaryPath}`)
