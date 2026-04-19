#!/usr/bin/env bash
# flush-agent-session.sh — self-service emergency flush for saturated sessions
#
# Usage: bash flush-agent-session.sh <agentId>
# Example: bash flush-agent-session.sh helm
#
# What it does:
#   1. Truncates the agent's active session JSONL to 0 bytes
#   2. Reports what was cleared
#
# After running: ask ragesaq for a gateway restart.
# Next session starts at near-zero pressure.
#
# Safe to run while the session is active — the current in-memory session
# is unaffected, but the NEXT session after restart loads from empty state.

set -euo pipefail

AGENT="${1:-}"
if [ -z "$AGENT" ]; then
  echo "Usage: $0 <agentId>"
  echo "Example: $0 helm"
  exit 1
fi

SESSIONS_DIR="/home/lumadmin/.openclaw/agents/$AGENT/sessions"
SESSIONS_JSON="$SESSIONS_DIR/sessions.json"

if [ ! -f "$SESSIONS_JSON" ]; then
  echo "ERROR: sessions.json not found at $SESSIONS_JSON"
  exit 1
fi

# Find the active session JSONL
ACTIVE_SESSION_ID=$(python3 -c "
import json, sys
with open('$SESSIONS_JSON') as f:
    d = json.load(f)
# Try common session key patterns
for suffix in ['webchat:${AGENT}-main', 'main']:
    key = 'agent:${AGENT}:' + suffix
    if key in d and 'sessionId' in d[key]:
        print(d[key]['sessionId'])
        sys.exit(0)
# Fallback: find highest-token session
best = max(d.values(), key=lambda v: v.get('totalTokens', 0), default=None)
if best and 'sessionId' in best:
    print(best['sessionId'])
" 2>/dev/null || echo "")

if [ -n "$ACTIVE_SESSION_ID" ]; then
  JSONL_PATH="$SESSIONS_DIR/$ACTIVE_SESSION_ID.jsonl"
  if [ -f "$JSONL_PATH" ]; then
    BEFORE=$(wc -c < "$JSONL_PATH")
    truncate -s 0 "$JSONL_PATH"
    echo "FLUSHED JSONL: $JSONL_PATH ($BEFORE bytes → 0)"
  else
    echo "JSONL not found (already clean): $JSONL_PATH"
  fi
else
  echo "WARNING: could not determine active session ID — skipping JSONL truncation"
fi

echo ""
echo "Done. Ask ragesaq to restart the gateway."
echo "Your next session will start at near-zero pressure."
