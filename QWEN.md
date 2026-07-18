# QWEN.md — Tennis Ranking System

## Project Overview

Full-stack web application for managing tennis doubles/singles matches, rankings, and seasons. Built with vanilla JavaScript (Vite SPA), Express 5, PostgreSQL, and Redis. Supports real-time ranking updates via SSE, FCM push notifications via BullMQ, AI-powered match screenshot parsing, and multi-season management with point-based rankings (4 winner / 1 loser).

Frontend uses Vietnamese UI labels; all code and comments are in English.

## Tech Stack

- **Frontend:** Vite 8, vanilla JS (`src/main.js` ~4000+ lines split into modules/components)
- **Backend:** Express 5, Node 22, ESM only (`import/export`)
- **Database:** PostgreSQL 15+ via `pg` + `pg-cursor`
- **Cache/Queue:** Redis via `ioredis`, BullMQ for FCM jobs
- **Security:** JWT (HS256) encrypted with AES-256-GCM in httpOnly cookies, HMAC-derived CSRF, bcrypt 14 rounds, Helmet, rate limiting
- **Deployment:** Docker (Dockerfile for FCM worker), PM2 cluster, or bare node

## Common Commands

```bash
npm install                          # Install dependencies
docker compose up -d postgres redis  # Start DB services only
npm run dev-full                     # Vite HMR (5173) + Express (3001)
npm run build                        # Vite production build → dist/
npm run server                       # Start Express server
npm start                            # Build + start server
npm test                             # Run all vitest tests
npm run test:watch                   # Vitest watch mode
npx eslint .                         # Lint (no npm script wired)
```

No docker-compose.yml in repo — DB services started separately. Dockerfile is for the FCM worker container only.

## Architecture

`server.js` (~627 lines) is a thin orchestration layer. All domain logic lives in imported modules.

```
config/      env.js (typed config), cookie.js
lib/         redis-cache.js, jwt-encryption.js, push-sender.js, notification-queue.js, ai-parser.js, security-helpers.js
middleware/  auth.js, csrf.js, compression.js, rate-limiter.js
routes/      *.js — each exports a createXxxRouter() factory
utils/       async-handler.js, excel-helper.js, stream-helper.js
migrations/  SQL + .sh apply scripts
database-postgresql.js   Sole production DB adapter (~1557 lines)
worker.js                FCM BullMQ background worker
src/                     Frontend SPA (main.js + modules/components/utils/lib)
```

### Key Patterns

**Router factory injection** — every route module exports a factory accepting `{ db, rankingsCache, checkAuth, ... }`. Wired in `server.js` via `app.use('/api/xxx', createXxxRouter(routeCtx))`.

**Three-tier cache** — PostgreSQL (source of truth with NOTIFY triggers) → Redis (24h TTL, stampede protection) → Client (type-specific TTLs, SSE invalidation).

**After every mutation, invalidate cache:**
```javascript
await rankingsCache.invalidateOnPlayerChange()
await rankingsCache.invalidateOnMatchChange(playDate)
await rankingsCache.invalidateOnSeasonChange()
```

**Always wrap async routes with `asyncHandler`** from `utils/async-handler.js`. Use `sendError`/`sendSuccess` for consistent response shape. Always call `sanitizeResponse()` to convert Date/timestamps to ISO strings.

**Database queries go through `database-postgresql.js`** — use parameterized arrays (`ANY($1::int[])`), never string interpolation. Wrap mutations in `BEGIN/COMMIT/ROLLBACK` with `client.release()` in `finally`.

## Required Environment Variables

`ADMIN_USERNAME`, `ADMIN_PASSWORD`, `EDITOR_USERNAME`, `EDITOR_PASSWORD`, `JWT_SECRET`, `CSRF_SECRET` are **required at startup** — server calls `process.exit(1)` if missing. See `.env.example` for full list including DB_*, REDIS_URL, rate limiting, CORS, AI parser, and FCM config.

## Coding Conventions

- **ESM only** — `import/export`, never `require()`
- **No semicolons**, single quotes, 2-space indent (Prettier config in `.prettierrc`)
- **ESLint rules:** `no-var` error, `prefer-const` warn, `eqeqeq` warn, `no-throw-literal` error
- **Validate input** with `express-validator` (`.trim().escape()` on free text), run through `handleValidationErrors`
- **Cookies** — always clear via `clearCookieAllPaths(res, name)`, never `res.clearCookie`
- **Subpath** — production default is `/tennis/`. Set `SUBPATH` or `BASE_PATH` env var. Vite config and server both honor it.
- **Two auth tiers:** `admin` (full CRUD), `editor` (match edits only)

## Frontend Cache Coherence

`src/main.js` polls server data version every 30s. On mismatch, fully clears client cache. After mutations, call `invalidateCache(['rankings', 'matches', 'playDates'])` with affected types.

## Gotchas

- `/api/init` is **never cached** — carries per-user auth state
- SSE endpoint `/api/events` has no request timeout; max 1000 clients (`MAX_SSE_CLIENTS`)
- Trust proxy is auto-on in production, off in dev — affects `req.ip` and rate-limit keying
- CSRF secret derived via `HMAC-SHA256(CSRF_SECRET, userId)`, no cookie session ID needed
- PM2 + Docker Redis race condition — use `./scripts/start-with-redis.sh` when Redis is in Docker with host port mapping

## Key Files

| File | Purpose |
|------|---------|
| `server.js` | Express app entry, wires all route factories |
| `database-postgresql.js` | All DB queries, ~1557 lines |
| `lib/redis-cache.js` | Redis caching, PG NOTIFY listener, version management |
| `src/main.js` | Frontend SPA entry |
| `config/env.js` | Typed config, validates required secrets |
| `middleware/auth.js` | JWT auth, role-based access |
| `middleware/csrf.js` | CSRF protection, HMAC-derived secrets |
| `worker.js` | FCM BullMQ background worker |
| `vite.config.js` | Vite 8 config, subpath deployment support |
| `ecosystem.config.cjs` | PM2 cluster configuration |

## Route Modules

Each file in `routes/` exports a factory function. New routes follow the same pattern — export `createXxxRouter()` accepting `routeCtx` deps.

| Route file | Domain |
|------------|--------|
| `auth-inline.js` | Login, logout, auth status |
| `players.js` | Player CRUD |
| `seasons.js` | Season CRUD, end/reactivate |
| `matches.js` | Match CRUD, bulk-create, image parsing, play dates |
| `rankings.js` | Lifetime, season, date rankings |
| `cups.js` | Cup tournament management |
| `export.js` | Excel export |
| `admin.js` | Admin dashboard, FCM control |
| `backup.js` | JSON backup/restore, clear data |
| `health.js` | Health checks, cache stats |
| `system.js` | CSRF token, data version, SSE, config debug |
| `users.js` | User CRUD, password change |
| `devices.js` | FCM token registration |
| `images.js` | Site image management (upload, preview, delete) |
