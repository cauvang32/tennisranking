# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

# Install all dependencies (including devDependencies for vite build)
COPY package*.json ./
RUN npm ci

# Copy source and build frontend
COPY . .
RUN npm run build

# ── Stage 2: Production ──────────────────────────────────────────────────────
FROM node:20-alpine

# dumb-init for proper PID 1 signal handling in containers
RUN apk add --no-cache dumb-init

WORKDIR /app

# Non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S tennisapp -u 1001 -G nodejs

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built frontend from build stage
COPY --from=build /app/dist ./dist

# Copy server-side source
COPY server.js database-postgresql.js database.js database-factory.js access-logger.js ./
COPY ecosystem.config.cjs ./
COPY config/ ./config/
COPY lib/ ./lib/
COPY middleware/ ./middleware/
COPY routes/ ./routes/
COPY utils/ ./utils/
COPY migrations/ ./migrations/
COPY data/postgres-init/ ./data/postgres-init/
COPY public/ ./public/

# Create logs directory
RUN mkdir -p /app/logs && chown -R tennisapp:nodejs /app

USER tennisapp

EXPOSE 3001

# Container health check — used by Docker and orchestrators
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["npx", "pm2-runtime", "ecosystem.config.cjs", "--env", "production"]
