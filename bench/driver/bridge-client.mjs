/**
 * Minimal WS bridge client for benchmark driver.
 * Connects to an OpenClaw gateway, sends messages, captures responses.
 * Based on the production gateway bridge pattern.
 */

import WebSocket from 'ws'
import crypto from 'node:crypto'

const DEFAULT_URL = 'ws://127.0.0.1:18790'
const DEFAULT_TOKEN = 'bench-test-token-do-not-use-in-prod'

export class BenchBridgeClient {
  constructor(opts = {}) {
    this.url = opts.url || DEFAULT_URL
    this.token = opts.token || DEFAULT_TOKEN
    this.ws = null
    this.pending = new Map() // reqId -> { resolve, reject, timer }
    this.connected = false
    this.sessionKey = null
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url)

      this.ws.on('open', () => {
        // Send connect handshake
        this._send('client.connect', {
          client: {
            id: 'bench-driver',
            displayName: 'Benchmark Driver',
            version: '1.0.0',
            platform: process.platform,
            mode: 'backend'
          },
          auth: { token: this.token }
        }).then(res => {
          this.connected = true
          resolve(res)
        }).catch(reject)
      })

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.id && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)
            clearTimeout(p.timer)
            this.pending.delete(msg.id)
            if (msg.error) {
              p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
            } else {
              p.resolve(msg.result)
            }
          }
        } catch (e) {
          // ignore parse errors
        }
      })

      this.ws.on('error', reject)
      this.ws.on('close', () => { this.connected = false })
    })
  }

  async sendMessage(sessionKey, message, opts = {}) {
    const start = performance.now()
    const result = await this._send('chat.send', {
      sessionKey,
      message,
      deliver: true,
      idempotencyKey: crypto.randomUUID(),
      ...opts
    })
    const latency = performance.now() - start
    return { result, latency }
  }

  async listSessions() {
    return this._send('sessions.list', {})
  }

  async getSessionMessages(sessionKey, limit = 100) {
    return this._send('sessions.messages', { sessionKey, limit })
  }

  async close() {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  _send(method, params, timeout = 120000) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timeout: ${method} after ${timeout}ms`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }
}
