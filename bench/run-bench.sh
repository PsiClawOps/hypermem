#!/usr/bin/env bash
# HyperMem Benchmark Suite — Sequential A/B runner
# 
# Runs identical OpenClaw stacks with different memory hooks.
# Same image, same config, same agent. Only the hook changes.
#
# Usage: ./run-bench.sh [hook1 hook2 ...]
# Default: ./run-bench.sh noop hypermem
# Full:    ./run-bench.sh noop hypermem mem0 letta

set -euo pipefail

BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_DIR="$BENCH_DIR/docker"
RESULTS_DIR="$BENCH_DIR/results"
DRIVER_DIR="$BENCH_DIR/driver"

# Default hooks to test (override with args)
HOOKS=("${@:-noop hypermem}")
if [ $# -eq 0 ]; then
  HOOKS=(noop hypermem)
fi

# Ensure results dir
mkdir -p "$RESULTS_DIR"

# Build bench image if needed
echo "=== Building benchmark image ==="
if ! docker image inspect openclaw-bench:local >/dev/null 2>&1; then
  echo "Building openclaw-bench:local..."
  docker build -t openclaw-bench:local -f "$COMPOSE_DIR/Dockerfile.bench" "$BENCH_DIR"
else
  echo "openclaw-bench:local exists, skipping build. (docker rmi openclaw-bench:local to force rebuild)"
fi

echo ""
echo "=== HyperMem Benchmark Suite ==="
echo "Hooks to test: ${HOOKS[*]}"
echo "Results dir: $RESULTS_DIR"
echo ""

for HOOK in "${HOOKS[@]}"; do
  echo "============================================"
  echo "=== Testing: $HOOK"
  echo "============================================"
  
  # Validate hook exists
  if [ ! -d "$BENCH_DIR/hooks/$HOOK" ]; then
    echo "ERROR: Hook directory not found: $BENCH_DIR/hooks/$HOOK"
    echo "Skipping $HOOK"
    continue
  fi

  # Determine compose profiles
  COMPOSE_ARGS="-f $COMPOSE_DIR/compose.yml"
  PROFILE_ARGS=""
  if [ "$HOOK" = "mem0" ]; then
    PROFILE_ARGS="--profile mem0"
  fi

  # Start the stack
  echo "[run] Starting OpenClaw + $HOOK..."
  BENCH_HOOK="$HOOK" docker compose $COMPOSE_ARGS $PROFILE_ARGS up -d --wait
  
  # Wait for gateway to be fully ready
  echo "[run] Waiting for gateway health..."
  for i in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:18790/healthz >/dev/null 2>&1; then
      echo "[run] Gateway healthy."
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo "[run] ERROR: Gateway did not become healthy in 150s"
      BENCH_HOOK="$HOOK" docker compose $COMPOSE_ARGS $PROFILE_ARGS logs --tail 50
      BENCH_HOOK="$HOOK" docker compose $COMPOSE_ARGS $PROFILE_ARGS down -v
      continue 2
    fi
    sleep 5
  done
  
  # Run conversations
  echo "[run] Running benchmark conversations..."
  node "$DRIVER_DIR/run-conversations.mjs" \
    --out "$RESULTS_DIR/$HOOK.json" \
    --url "ws://127.0.0.1:18790" \
    || echo "[run] WARNING: Driver exited with error for $HOOK"
  
  # Capture gateway logs for debugging
  BENCH_HOOK="$HOOK" docker compose $COMPOSE_ARGS $PROFILE_ARGS logs --tail 200 > "$RESULTS_DIR/${HOOK}_gateway.log" 2>&1
  
  # Tear down completely
  echo "[run] Tearing down $HOOK stack..."
  BENCH_HOOK="$HOOK" docker compose $COMPOSE_ARGS $PROFILE_ARGS down -v
  
  echo "[run] $HOOK complete."
  echo ""
done

echo "============================================"
echo "=== All runs complete ==="
echo "============================================"

# Score and generate comparison
if [ -f "$DRIVER_DIR/score.mjs" ]; then
  echo "[run] Scoring results..."
  node "$DRIVER_DIR/score.mjs" --results-dir "$RESULTS_DIR"
fi

if [ -f "$DRIVER_DIR/report.mjs" ]; then
  echo "[run] Generating comparison report..."
  node "$DRIVER_DIR/report.mjs" --results-dir "$RESULTS_DIR" --out "$RESULTS_DIR/comparison.md"
fi

echo ""
echo "Results: $RESULTS_DIR/"
ls -la "$RESULTS_DIR/"
