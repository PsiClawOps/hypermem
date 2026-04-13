// noop memory hook — baseline
// Does nothing. No memory recording, no context enrichment.
// The agent sees only the current conversation window.

export default {
  name: 'bench-memory-noop',
  version: '1.0.0',

  async onMessage(event) {
    // No-op: don't record anything
    return {}
  },

  async onContextBuild(event) {
    // No-op: don't enrich context
    return {}
  },

  async onSessionStart(event) {
    return {}
  },

  async onSessionEnd(event) {
    return {}
  }
}
