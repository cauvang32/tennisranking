# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Install all dependencies (including devDependencies for vite build)
COPY package*.json ./
RUN npm ci

# Copy source and build frontend
COPY . .
RUN npm run build

# ── Stage 2: Production ──────────────────────────────────────────────────────
FROM node:22-alpine

# dumb-init for proper PID 1 signal handling in containers
RUN apk add --no-cache dumb-init curl

WORKDIR /app

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S tennisapp -u 1001 -G nodejs

# Install production dependencies only (layer cached unless package.json changes)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built frontend from build stage
COPY --from=build /app/dist ./dist

# Copy server-side source (only files needed at runtime)
COPY server.js worker.js database-postgresql.js access-logger.js ./
COPY ecosystem.config.cjs ./
COPY config/ ./config/
COPY lib/ ./lib/
COPY middleware/ ./middleware/
COPY routes/ ./routes/
COPY utils/ ./utils/
COPY migrations/ ./migrations/
COPY data/postgres-init/ ./data/postgres-init/
COPY public/ ./public/

# Create logs directory with correct ownership
RUN mkdir -p /app/logs && chown -R tennisapp:nodejs /app

USER tennisapp

EXPOSE 3001

# NOTE: HEALTHCHECK is NOT defined here because the same image is used for
# both the main app (port 3001) and the FCM worker (port 3002).
# Each service overrides the healthcheck in docker-compose.yml with the
# correct port. Docker Compose healthcheck settings take precedence over
# the Dockerfile HEALTHCHECK instruction.

ENTRYPOINT ["dumb-init", "--"]
CMD ["npx", "pm2-runtime", "ecosystem.config.cjs", "--env", "production"]
