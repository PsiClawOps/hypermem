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
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '9800' },
    'data-dir': { type: 'string', default: path.join(os.homedir(), '.openclaw', 'hypermem-bench') },
  },
});

const PORT = parseInt(args.port, 10);
const DATA_DIR = args['data-dir'];

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
    },
    indexer: {
      enabled: true,
      factExtractionMode: 'tiered',
      periodicInterval: 60000,
    },
    embedding: {
      ollamaUrl: 'http://localhost:11434',
      model: 'nomic-embed-text',
      dimensions: 768,
      timeout: 30000,
      batchSize: 32,
    },
  });
  console.log(`[bridge] HyperMem initialized (dataDir: ${DATA_DIR})`);
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

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/healthz') {
      return respond(res, 200, { ok: true, engine: 'hypermem-bench-bridge' });
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
      const results = await hm.semanticSearch(agentId, query, {
        limit: limit || 10,
        tables: ['facts', 'knowledge', 'episodes'],
      });
      return respond(res, 200, { ok: true, results });
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
