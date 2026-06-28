#!/usr/bin/env bash
# ── wait-for-redis-and-start.sh ──────────────────────────────────────────────
# Waits for Docker Redis port mapping to be ready, then starts PM2.
#
# Usage:
#   ./scripts/start-with-redis.sh [--env production]
#
# This script is the recommended way to start the tennis PM2 workers when
# Redis runs inside Docker with a host port mapping (127.0.0.1:6380).
# Docker's port forwarding takes 10-30s to become ready after the container
# starts. This script waits for that before launching PM2.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REDIS_PORT="${REDIS_PORT:-6380}"
MAX_WAIT=120  # seconds
WAIT_INTERVAL=2

echo "⏳ Waiting for Redis on port ${REDIS_PORT} (max ${MAX_WAIT}s)..."
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  if redis-cli -p "$REDIS_PORT" ping 2>/dev/null | grep -q PONG; then
    echo "✅ Redis is ready after ${ELAPSED}s"
    exec pm2 start "$SCRIPT_DIR/ecosystem.config.cjs" --env "${1:-production}"
  fi
  sleep "$WAIT_INTERVAL"
  ELAPSED=$((ELAPSED + WAIT_INTERVAL))
done

echo "❌ Redis not ready after ${MAX_WAIT}s — giving up"
exit 1
