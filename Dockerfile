# ── FCM Worker (single-stage, minimal) ───────────────────────────────────────
# This image is used ONLY for the FCM worker container.
# The main app (tennis-app) runs locally via PM2, not in Docker.
#
# Worker dependencies:
#   - worker.js (entry point)
#   - config/env.js (environment config)
#   - database-postgresql.js (PostgreSQL client)
#   - access-logger.js (logging)
#   - lib/push-sender.js (FCM sender)
#   - lib/notification-queue.js (BullMQ queue)
#
# Does NOT need: dist/, server.js, ecosystem.config.cjs, public/,
#               middleware/, routes/, utils/, migrations/, data/

FROM node:22-alpine

# dumb-init for proper PID 1 signal handling in containers
# curl for Docker HEALTHCHECK probes
RUN apk add --no-cache dumb-init curl

WORKDIR /app

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S tennisapp -u 1001 -G nodejs

# Install production dependencies only (layer cached unless package.json changes)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy ONLY files the worker needs
COPY worker.js ./
COPY config/ ./config/
COPY database-postgresql.js ./
COPY access-logger.js ./
COPY lib/push-sender.js ./lib/
COPY lib/notification-queue.js ./lib/

# Create logs directory with correct ownership
RUN mkdir -p /app/logs && chown -R tennisapp:nodejs /app

USER tennisapp

# Worker exposes a health endpoint on port 3002 for Docker HEALTHCHECK.
# The compose file defines the healthcheck separately.

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "worker.js"]
