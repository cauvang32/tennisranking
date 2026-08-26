# ── FCM Worker (single-stage, minimal) ───────────────────────────────────────
# This image is used ONLY for the FCM worker container.
# The main app (tennis-app) runs locally via PM2, not in Docker.
#
# Worker dependencies are authored in TypeScript and compiled in the build stage.
#
# Does NOT need: dist/, the HTTP server runtime, ecosystem.config.cjs, public/,
#               middleware/, routes/, utils/, migrations/, data/

FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build

WORKDIR /app
COPY package*.json tsconfig*.json ./
RUN npm ci
COPY *.ts ./
COPY config/ ./config/
COPY lib/ ./lib/
COPY middleware/ ./middleware/
COPY routes/ ./routes/
COPY scripts/ ./scripts/
COPY shared/ ./shared/
COPY types/ ./types/
COPY utils/ ./utils/
RUN npm run build:server

FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

# dumb-init for proper PID 1 signal handling in containers
# curl for Docker HEALTHCHECK probes
RUN apk add --no-cache dumb-init curl

WORKDIR /app

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S tennisapp -u 1001 -G nodejs

# Install production dependencies only (layer cached unless package.json changes)
COPY package*.json ./
RUN npm ci --omit=dev && \
    npm cache clean --force && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Copy only the compiled worker runtime.
COPY --from=build /app/build ./build

USER tennisapp

# Worker exposes a health endpoint on port 3002 for Docker HEALTHCHECK.
# The compose file defines the healthcheck separately.

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "build/worker.js"]
