#!/usr/bin/env bash
# Wait for Redis to be ready via the configured port, then start PM2.
# Required when Redis runs inside Docker with a host port mapping
# (e.g. redis://127.0.0.1:6380) — Docker's port forwarding takes 10-30s.
#
# Usage: ./scripts/start-with-redis.sh [pm2 args...]
# Reads REDIS_PORT from .env (defaults to 6379).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

# Read REDIS_PORT from .env (default 6379)
REDIS_PORT="6379"
if [ -f "$ENV_FILE" ]; then
  PORT_LINE=$(grep -E '^REDIS_PORT=' "$ENV_FILE" 2>/dev/null | head -1 || true)
  if [ -n "$PORT_LINE" ]; then
    REDIS_PORT=$(echo "$PORT_LINE" | cut -d'=' -f2 | tr -d '[:space:]')
  fi
  # Also check REDIS_URL for port number as fallback
  if [ "$REDIS_PORT" = "6379" ]; then
    URL_LINE=$(grep -E '^REDIS_URL=' "$ENV_FILE" 2>/dev/null | head -1 || true)
    if [ -n "$URL_LINE" ]; then
      EXTRACTED=$(echo "$URL_LINE" | grep -oE ':[0-9]+' | tail -1 | tr -d ':')
      if [ -n "$EXTRACTED" ] && [ "$EXTRACTED" != "6379" ]; then
        REDIS_PORT="$EXTRACTED"
      fi
    fi
  fi
fi

echo "⏳ Waiting for Redis on port ${REDIS_PORT}..."
MAX_WAIT=120  # seconds
ELAPSED=0

while ! (echo "PING" | nc -w1 127.0.0.1 "${REDIS_PORT}" >/dev/null 2>&1); do
  if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
    echo "❌ Redis on port ${REDIS_PORT} did not become ready within ${MAX_WAIT}s"
    exit 1
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

echo "✅ Redis is ready on port ${REDIS_PORT} — starting PM2..."
exec pm2 startOrRestart ecosystem.config.js "$@"
