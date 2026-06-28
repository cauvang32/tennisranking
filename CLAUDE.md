# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Tennis doubles ranking system — full-stack web app with Express + PostgreSQL + Redis backend, vanilla-JS Vite SPA frontend. Manages players, seasons, doubles/singles matches, and a point-based ranking (4 winner / 1 loser) with multi-season and lifetime views, money penalties, and real-time SSE updates. See `README.md` and `docs/architecture.md` for user-facing details and system diagrams.

## Common Commands

```bash
# Install
npm install

# Local dev (hybrid: PG+Redis in Docker, app on host)
docker compose up -d postgres redis
npm run dev-full          # Vite (5173) + Express (3001) via concurrently

# Build / production
npm run build             # vite build → dist/
npm run server            # node server.js (production)
npm start                 # build + server
npm run deploy:production # build + server with NODE_ENV=production
npm run deploy:subpath    # BASE_PATH=/tennis/ build + serve

# Full stack via Docker
docker compose up -d      # app + postgres + redis (port 3001)

# Tests
npm test                  # vitest run (all)
npm run test:unit         # only tests/unit
npm run test:watch        # vitest watch
npm run test:cors         # quick CORS check via curl

# Health / diagnostics
npm run health-check      # GET /health
```

There is no separate lint script — ESLint config exists at `.eslintrc.json` but no `npm run lint` is wired up. Run `npx eslint .` directly if needed.

## Architecture

`server.js` is a thin orchestration layer (~595 lines). It boots config, db, cache, middleware, SSE, then wires router factories together via a shared `routeCtx` object. **All domain logic lives in the modules it imports** — never add business logic to `server.js`.

```
config/      env.js (typed config, validates required secrets), cookie.js
lib/         redis-cache.js, jwt-encryption.js (AES-256-GCM), security-helpers.js
middleware/  auth.js, csrf.js, compression.js, rate-limiter.js
routes/      *.js — each exports a `createXxxRouter({ db, rankingsCache, ... })` factory
utils/       async-handler.js, excel-helper.js, stream-helper.js
migrations/  SQL + .sh apply scripts (tracked via flag env vars)
database-postgresql.js   Sole production DB adapter (~1200 lines)
src/main.js  Frontend SPA (~4000 lines, vanilla JS)
src/style.css
```

### Router factory injection

Every route module exports a factory; dependencies are passed in, not imported. This keeps `server.js` as the single wiring point.

```javascript
// routes/players.js
export const createPlayerRouter = ({ db, checkAuth, rankingsCache, handleValidationErrors }) => {
  const router = Router()
  router.get('/', checkAuth, asyncHandler(async (req, res) => {
    const { data } = await rankingsCache.getOrSet('players', () => db.getPlayers())
    res.json(sanitizeResponse(data))
  }))
  return router
}
```

Wired in `server.js` via `app.use('/api/players', createPlayerRouter(routeCtx))`.

### Three-tier cache

1. **PostgreSQL** — source of truth, with `NOTIFY` triggers on data mutations.
2. **Redis** (`lib/redis-cache.js`) — 24h TTL, stampede protection via distributed locks, preloads startup keys (`rankings:lifetime`, `players`, `seasons`, etc.) on boot. Subscribes to PG `LISTEN/NOTIFY` for invalidation; emits `versionChange` events.
3. **Client** (`src/main.js`) — type-specific TTLs (rankings 2m, matches 1m, players 10m, version-poll 30s). Polls `/api/events` SSE + server data version to invalidate.

`server.js` listens to `rankingsCache.on('versionChange', ...)` and fans out to all SSE clients on `/api/events`. Cache headers (`ETag: W/"v-{version}"`) on `/api` GETs enable 304s.

### Auth & security

- JWT (HS256, 15m access / 7d refresh) encrypted with **AES-256-GCM** in httpOnly cookies (`lib/jwt-encryption.js`).
- CSRF: HMAC-derived secret from user ID + double-submit token (`middleware/csrf.js`). Required on all non-GET requests via `X-CSRF-Token` header.
- bcrypt with 14 rounds (`BCRYPT_ROUNDS`).
- Helmet with strict CSP, HSTS, Permissions-Policy, frameguard deny.
- Redis-backed rate limiting with dynamic scaling when CPU>80% or RAM>85% (`middleware/rate-limiter.js`).
- Two tiers: `admin` (full CRUD) and `editor` (match edits only). Login checks DB users first, then env-credential fallback (`ADMIN_USERNAME`/`EDITOR_USERNAME`).

## Required env vars

`ADMIN_USERNAME`, `ADMIN_PASSWORD`, `EDITOR_USERNAME`, `EDITOR_PASSWORD`, `JWT_SECRET`, `CSRF_SECRET` are **all required at startup** — `config/env.js` calls `process.exit(1)` if any are missing. Use `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` to generate. See `.env.example` for the full list (DB_*, REDIS_URL, RATE_LIMIT_*, BCRYPT_ROUNDS, SUBPATH, ALLOWED_ORIGINS, etc.).

## Critical Patterns

### After every mutation, invalidate cache
```javascript
await rankingsCache.invalidateOnPlayerChange()
await rankingsCache.invalidateOnMatchChange(playDate)
await rankingsCache.invalidateOnSeasonChange()
```
PG triggers also auto-invalidate via `NOTIFY` (`migrations/add-cache-notify-triggers.sql`), but explicit calls are still required for in-process state.

### Always wrap async routes
Use `asyncHandler` from `utils/async-handler.js` so errors flow to the global error handler. Use `sendError`/`sendSuccess` from `utils/async-handler.js` for consistent response shape with error codes. Always call `sanitizeResponse()` to convert Date objects / Unix timestamps to ISO strings (prevents timestamp-disclosure attacks).

### Validate input
Use `express-validator` with `.trim().escape()` on free-text fields, then run through `handleValidationErrors`.

### Database access
- All queries go through `database-postgresql.js`. Use parameterized arrays via `ANY($1::int[])` or `unnest($1::int[])`, **never** string interpolation.
- Wrap multi-step mutations in `BEGIN/COMMIT/ROLLBACK` with `client.release()` in `finally`.
- Use `INSERT ... ON CONFLICT ... DO NOTHING` for idempotent inserts (e.g., `season_players`).
- Window functions (`ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY play_date DESC)`) replace N+1 queries for batch "form" lookups.

### Migrations
Apply in order via the `apply-*-migration.sh` scripts in the repo root. Each is idempotent. PG init scripts also live in `data/postgres-init/`.

## Frontend cache coherence

`src/main.js` polls server data version every 30s; on mismatch, it **fully clears** the client cache. After a successful mutation, call `invalidateCache(['rankings', 'matches', 'playDates'])` with the affected types only.

The frontend uses Vietnamese UI labels; code/comments are English. Match types: `duo` (doubles) and `solo` (singles). Players and matches are scoped to seasons via `season_players`.

## Deployment Modes

| Mode | Command | Notes |
|------|---------|-------|
| Docker | `docker compose up -d` | App + PG + Redis, recommended. `pm2-runtime` inside container, `dumb-init` PID 1. |
| PM2 cluster | `./scripts/start-with-redis.sh production` | Requires external PG + Redis. **When Redis runs inside Docker with a host port mapping**, use the startup script to wait for Docker's port forwarding to be ready before PM2 boots. Cluster mode, 2 workers by default. |
| Bare node | `NODE_ENV=production node server.js` | Single process. |
| Dev | `npm run dev-full` | Vite HMR + Express. |

PM2/cluster is safe because: rate limits use Redis (`rate-limit-redis-tennis:<name>`), each worker subscribes to PG `LISTEN/NOTIFY` for SSE, and the data version uses a Redis version-lock so all workers broadcast the same version number.

## Gotchas

- **ESM only** — use `import/export`, never `require()`. Node 20.
- **Subpath** — production default is `/tennis/`. Set `SUBPATH` (or `BASE_PATH`) env var. Static serving and API normalization both honor it.
- **Cookies** — always clear via `clearCookieAllPaths(res, name)` (not `res.clearCookie`) due to historical path variations.
- **`/api/init` is never cached** — it carries per-user auth state. Other auth routes skip the ETag middleware.
- **SSE** — request timeout middleware explicitly skips `/api/events`; set `MAX_SSE_CLIENTS` (default 1000).
- **Trust proxy** — auto-on in production. Off in dev. Affects `req.ip` and rate-limit keying.
- **CSRF secret derivation** — `HMAC-SHA256(CSRF_SECRET, userId)`. Secret is derived deterministically from the user ID (or `'anonymous'` for guests), with no cookie session ID required.
- **PM2 + Docker Redis race** — When PM2 workers run on the host but Redis is inside Docker with a port mapping (e.g. `127.0.0.1:6380`), the port forwarding isn't ready when PM2 boots. Use `./scripts/start-with-redis.sh` to wait. The FCM worker avoids this by connecting via Docker internal networking (`redis://tennis-redis:6379`).
