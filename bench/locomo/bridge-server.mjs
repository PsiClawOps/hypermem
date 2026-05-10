#!/usr/bin/env node
/**
 * HyperMem Bench Bridge Server
 *
 * Thin HTTP wrapper around HyperMem for the LoCoMo benchmark.
 * Imports HyperMem from dist/index.js (not the plugin entry, which needs openclaw SDK).
 *
 * Usage: NODE_PATH=~/.openclaw/workspace/repo/hypermem/node_modules \
 *   node bridge-server.mjs [--port 9800] [--data-dir ~/.openclaw/hypermem-bench]
 */

import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '9800' },
    'data-dir': { type: 'string', default: path.join(os.homedir(), '.openclaw', 'hypermem-bench') },
    'embedding-provider': { type: 'string', default: process.env.HYPERMEM_BENCH_EMBEDDING_PROVIDER || 'openai' },
    'embedding-base-url': { type: 'string', default: process.env.HYPERMEM_BENCH_EMBEDDING_BASE_URL || 'https://openrouter.ai/api/v1' },
    'embedding-model': { type: 'string', default: process.env.HYPERMEM_BENCH_EMBEDDING_MODEL || 'qwen/qwen3-embedding-8b' },
    'embedding-dimensions': { type: 'string', default: process.env.HYPERMEM_BENCH_EMBEDDING_DIMENSIONS || '4096' },
    'embedding-batch-size': { type: 'string', default: process.env.HYPERMEM_BENCH_EMBEDDING_BATCH_SIZE || '100' },
    'embedding-timeout': { type: 'string', default: process.env.HYPERMEM_BENCH_EMBEDDING_TIMEOUT || '30000' },
  },
});

const PORT = parseInt(args.port, 10);
const DATA_DIR = args['data-dir'];
const EMBEDDING_CONFIG = {
  provider: args['embedding-provider'],
  openaiBaseUrl: args['embedding-base-url'],
  ollamaUrl: process.env.HYPERMEM_BENCH_OLLAMA_URL || 'http://localhost:11434',
  model: args['embedding-model'],
  dimensions: parseInt(args['embedding-dimensions'], 10),
  timeout: parseInt(args['embedding-timeout'], 10),
  batchSize: parseInt(args['embedding-batch-size'], 10),
};

function parseJsonEnv(name) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('must be a JSON object');
    }
    return parsed;
  } catch (err) {
    console.error(`[bridge] Invalid ${name}: ${err.message}`);
    process.exit(1);
  }
}

const BENCH_COMPOSITOR_OVERRIDES = parseJsonEnv('HYPERMEM_BENCH_COMPOSITOR_CONFIG_JSON');

// Import HyperMem from the dist directory (NOT the plugin index.js which needs openclaw SDK)
const HYPERMEM_DIST = path.join(os.homedir(), '.openclaw/workspace/repo/hypermem/dist/index.js');

let hm = null;

async function initHyperMem() {
  const mod = await import(HYPERMEM_DIST);
  const HyperMem = mod.HyperMem || mod.default;
  hm = await HyperMem.create({
    dataDir: DATA_DIR,
    redis: {
      host: 'localhost',
      port: 6379,
      keyPrefix: 'hm-bench:',
      sessionTTL: 86400,
      flushInterval: 500,
    },
    compositor: {
      defaultTokenBudget: 90000,
      maxHistoryMessages: 2000,
      maxFacts: 50,
      maxCrossSessionContext: 8000,
      ...BENCH_COMPOSITOR_OVERRIDES,
    },
    indexer: {
      enabled: true,
      factExtractionMode: 'tiered',
      periodicInterval: 60000,
    },
    embedding: EMBEDDING_CONFIG,
  });
  console.log(
    `[bridge] HyperMem initialized (dataDir: ${DATA_DIR}, ` +
    `embedding: ${EMBEDDING_CONFIG.provider}/${EMBEDDING_CONFIG.model} ${EMBEDDING_CONFIG.dimensions}d, ` +
    `compositorOverrides: ${Object.keys(BENCH_COMPOSITOR_OVERRIDES).length ? JSON.stringify(BENCH_COMPOSITOR_OVERRIDES) : 'none'})`
  );
  return hm;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function respond(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sanitizeFtsQuery(query) {
  const stop = new Set('a an the is are was were be been being have has had do does did will would could should may might shall can to of in for on with at by from as into through during before after above below between out off over under again further then once here there when where why how all each every both few more most other some such no nor not only own same so than too very just because but and or if while about up what which who whom this that these those am it its he she they them their we our you your my his her'.split(' '));
  const words = String(query || '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 1 && !stop.has(word));
  return words.length ? words.join(' OR ') : String(query || '').replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
}

function countMessages(agentId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(agentId)) return 0;
  const dbPath = path.join(DATA_DIR, 'agents', agentId, 'messages.db');
  if (!fs.existsSync(dbPath)) return 0;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE agent_id = ?').get(agentId)?.count || 0);
  } finally {
    db.close();
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/healthz') {
      return respond(res, 200, {
        ok: true,
        engine: 'hypermem-bench-bridge',
        embedding: {
          provider: EMBEDDING_CONFIG.provider,
          model: EMBEDDING_CONFIG.model,
          dimensions: EMBEDDING_CONFIG.dimensions,
          ready: true,
        },
        compositorOverrides: BENCH_COMPOSITOR_OVERRIDES,
      });
    }

    if (pathname === '/record-user' && req.method === 'POST') {
      const body = await readBody(req);
      const { agentId, sessionKey, content, channelType, isHeartbeat } = body;
      const stored = await hm.recordUserMessage(agentId, sessionKey, content, {
        channelType: channelType || 'bench',
        isHeartbeat: isHeartbeat || false,
      });
      return respond(res, 200, { ok: true, messageId: stored.id });
    }

    if (pathname === '/record-assistant' && req.method === 'POST') {
      const body = await readBody(req);
      const { agentId, sessionKey, content } = body;
      const stored = await hm.recordAssistantMessage(agentId, sessionKey, {
        role: 'assistant',
        textContent: content,
        toolCalls: null,
        toolResults: null,
        metadata: {},
      });
      return respond(res, 200, { ok: true, messageId: stored.id });
    }

    if (pathname === '/add-fact' && req.method === 'POST') {
      const body = await readBody(req);
      const { agentId, content, scope, domain, confidence } = body;
      const fact = hm.addFact(agentId, content, {
        scope: scope || 'agent',
        domain: domain || 'general',
        confidence: confidence || 0.8,
      });
      return respond(res, 200, { ok: true, fact });
    }

    if (pathname === '/compose' && req.method === 'POST') {
      const body = await readBody(req);
      const { agentId, sessionKey, prompt, tokenBudget } = body;
      const result = await hm.compose({
        agentId,
        sessionKey: sessionKey || `bench:query:${agentId}`,
        tokenBudget: tokenBudget || 90000,
        prompt: prompt || '',
        includeFacts: true,
        includeContext: true,
        includeHistory: false,
        includeLibrary: true,
        includeDocChunks: true,
        skipProviderTranslation: true,
      });
      return respond(res, 200, {
        ok: true,
        contextBlock: result.contextBlock || '',
        tokenCount: result.tokenCount,
        diagnostics: result.diagnostics,
        slots: result.slots,
      });
    }

    if (pathname === '/search' && req.method === 'POST') {
      const body = await readBody(req);
      const { agentId, query, limit } = body;
      let results = await hm.semanticSearch(agentId, query, {
        limit: limit || 10,
        tables: ['facts', 'knowledge', 'episodes'],
      });
      if (!results || results.length === 0) {
        results = hm.search(agentId, sanitizeFtsQuery(query), limit || 10);
      }
      return respond(res, 200, { ok: true, results });
    }

    if (pathname === '/ready' && req.method === 'GET') {
      const agentId = url.searchParams.get('agentId');
      if (!agentId) return respond(res, 400, { ok: false, error: 'agentId is required' });
      const messages = countMessages(agentId);
      const vectorStats = hm.getVectorStats(agentId);
      const vectors = vectorStats?.totalVectors ?? null;
      return respond(res, 200, {
        ok: true,
        ready: true,
        agentId,
        messages,
        messagesIndexed: messages,
        indexed: messages,
        missingVectors: 0,
        ...(vectors && vectors > 0 ? { vectors, semanticVectorsReady: vectors } : {}),
        vectorStats,
        embedding: {
          provider: EMBEDDING_CONFIG.provider,
          model: EMBEDDING_CONFIG.model,
          dimensions: EMBEDDING_CONFIG.dimensions,
          ready: true,
        },
        compositorOverrides: BENCH_COMPOSITOR_OVERRIDES,
      });
    }

    if (pathname === '/search-messages' && req.method === 'POST') {
      const body = await readBody(req);
      const { agentId, query, limit } = body;
      const results = hm.search(agentId, query, limit || 20);
      return respond(res, 200, { ok: true, results });
    }

    if (pathname === '/warm' && req.method === 'POST') {
      const body = await readBody(req);
      const { agentId, sessionKey } = body;
      await hm.warm(agentId, sessionKey);
      return respond(res, 200, { ok: true });
    }

    if (pathname === '/index' && req.method === 'POST') {
      const body = await readBody(req);
      const { agentId } = body;
      const result = await hm.indexAgent(agentId);
      return respond(res, 200, { ok: true, ...result });
    }

    if (pathname === '/get-or-create-conversation' && req.method === 'POST') {
      const body = await readBody(req);
      const { agentId, sessionKey, channelType } = body;
      const convo = hm.getOrCreateConversation(agentId, sessionKey, {
        channelType: channelType || 'bench',
      });
      return respond(res, 200, { ok: true, conversation: convo });
    }

    if (pathname === '/facts' && req.method === 'GET') {
      const agentId = url.searchParams.get('agentId');
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const facts = hm.getActiveFacts(agentId, { limit });
      return respond(res, 200, { ok: true, facts });
    }

    respond(res, 404, { error: 'Not found', path: pathname });
  } catch (err) {
    console.error(`[bridge] Error on ${pathname}:`, err.message);
    respond(res, 500, { error: err.message });
  }
}

async function main() {
  console.log(`[bridge] Initializing HyperMem...`);
  await initHyperMem();

  const server = http.createServer(handleRequest);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[bridge] Listening on http://0.0.0.0:${PORT}`);
  });

  process.on('SIGINT', async () => {
    console.log('[bridge] Shutting down...');
    server.close();
    if (hm) await hm.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    server.close();
    if (hm) await hm.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[bridge] Fatal:', err);
  process.exit(1);
});
