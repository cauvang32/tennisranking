# QWEN.md — Tennis Ranking System

## Project Overview

Full-stack web application for managing tennis doubles/singles matches, rankings, and seasons. Built with TypeScript — a React + Vite SPA frontend and an Express 5 backend — with PostgreSQL and Redis. Supports real-time ranking updates via SSE, FCM push notifications via BullMQ, AI-powered match screenshot parsing, and multi-season management with point-based rankings (4 winner / 1 loser).

Frontend uses Vietnamese UI labels; all code and comments are in English.

## Tech Stack

- **Frontend:** React 19 + TypeScript, Vite 8 SPA (`src/main.tsx` → `src/app/App.tsx`, features in `src/features/<feature>/`)
- **Backend:** Express 5, Node 22, TypeScript (ESM, NodeNext), compiled to `build/`
- **Database:** PostgreSQL 15+ via `pg` + `pg-cursor`
- **Cache/Queue:** Redis via `ioredis`, BullMQ for FCM jobs
- **Security:** JWT (HS256) encrypted with AES-256-GCM in httpOnly cookies, HMAC-derived CSRF, bcrypt 14 rounds, Helmet, rate limiting
- **Shared types:** `shared/domain.ts` (API/domain contracts used by both sides)
- **Deployment:** Docker (Dockerfile for FCM worker), PM2 cluster, or bare node

## Common Commands

```bash
npm install                          # Install dependencies
docker compose up -d postgres redis  # Start DB services only
npm run dev-full                     # Vite HMR (5173) + Express (3001, tsx watch)
npm run build                        # typecheck + Vite client (dist/) + server (build/)
npm run server                       # Start compiled Express server (build/server.js)
npm run typecheck                    # tsc -b across all three project references
npm run lint                         # ESLint (backend + frontend + tests)
npm test                             # Vitest (tests/unit + tests/frontend)
```

## Architecture

The backend is fully TypeScript and compiles to `build/` (`tsconfig.server.json`). `server.ts` (~627 lines) is a thin orchestration layer; all domain logic lives in imported modules.

```
server.ts            Express app entry, wires all route factories
database-postgresql.ts  Sole production DB adapter
config/      env.ts (typed config), cookie.ts, upload-paths.ts
lib/         redis-cache.ts, jwt-encryption.ts, push-sender.ts, notification-queue.ts, ai-parser.ts, security-helpers.ts, upload-storage.ts, image-dimensions.ts
middleware/  auth.ts, csrf.ts, compression.ts, rate-limiter.ts, api-cache-control.ts
routes/      *.ts — each exports a createXxxRouter() factory
utils/       async-handler.ts, excel-helper.ts, stream-helper.ts
scripts/     migrate.ts, migrate-k3s.ts, migration-utils.ts
shared/      domain.ts — API/domain type contracts
worker.ts                FCM BullMQ background worker
src/                     React SPA (main.tsx, app/, features/, components/, api/, utils/)
```

### Key Patterns

**Router factory injection** — every route module exports a factory accepting `{ db, rankingsCache, checkAuth, ... }`. Wired in `server.ts` via `app.use('/api/xxx', createXxxRouter(routeCtx))`.

**Three-tier cache** — PostgreSQL (source of truth with NOTIFY triggers) → Redis (24h TTL, stampede protection) → Client (type-specific TTLs, SSE invalidation).

**After every mutation, invalidate cache:**
```ts
await rankingsCache.invalidateOnPlayerChange()
await rankingsCache.invalidateOnMatchChange(playDate)
await rankingsCache.invalidateOnSeasonChange()
```

**Always wrap async routes with `asyncHandler`** from `utils/async-handler.ts`. Use `sendError`/`sendSuccess` for consistent response shape. Always call `sanitizeResponse()` to convert Date/timestamps to ISO strings.

**Database queries go through `database-postgresql.ts`** — use parameterized arrays (`ANY($1::int[])`), never string interpolation. Wrap mutations in `BEGIN/COMMIT/ROLLBACK` with `client.release()` in `finally`.

**NodeNext imports** — relative backend imports keep the `.js` extension (e.g. `from './env.js'`) because the compiled ESM output preserves them. The frontend uses `moduleResolution: "Bundler"` (extensionless).

## Required Environment Variables

`ADMIN_USERNAME`, `ADMIN_PASSWORD`, `EDITOR_USERNAME`, `EDITOR_PASSWORD`, `JWT_SECRET`, `CSRF_SECRET` are **required at startup** — the server calls `process.exit(1)` if missing. See `.env.example` for the full list including DB_*, REDIS_URL, rate limiting, CORS, AI parser, and FCM config. `config/vite-env/` is the Vite `envDir` (isolated from the backend `.env`).

## Coding Conventions

- **TypeScript everywhere** — strict in the frontend/tools projects, relaxed (`strict: false`) in the server project
- **Semicolons** per surrounding file (Prettier config in `.prettierrc`), single quotes, 2-space indent
- **Validate input** with `express-validator` (`.trim().escape()` on free text), run through `handleValidationErrors`
- **Cookies** — always clear via `clearCookieAllPaths(res, name)`, never `res.clearCookie`
- **Subpath** — production default is `/tennis/`. Set `BASE_PATH` (or `SUBPATH`) env var; Vite config and server both honor it
- **Two auth tiers:** `admin` (full CRUD), `editor` (match edits only)

## Frontend Cache Coherence

`src/app/app-context.tsx` opens an SSE stream for real-time version updates; on SSE error it falls back to a 15s data-version poll. Features read shared players/seasons from context and call `api.*` directly. After mutations, call `app.reload()` (re-fetches `/api/init`).

## Gotchas

- `/api/init` is **never cached** — carries per-user auth state
- SSE endpoint `/api/events` has no request timeout; max 1000 clients (`MAX_SSE_CLIENTS`)
- Trust proxy is auto-on in production, off in dev — affects `req.ip` and rate-limit keying
- CSRF secret derived via `HMAC-SHA256(CSRF_SECRET, userId)`, no cookie session ID needed
- **`player_daily_stats`** has a NO-ACTION FK to `players` and is populated by a trigger on `matches`; every data-clearing path must `DELETE`/`TRUNCATE` it before `players`
- PM2 + Docker Redis race condition — use `./scripts/start-with-redis.sh` when Redis is in Docker with host port mapping
- Tests run via `vitest.config.ts` (forces `NODE_ENV=test` so React uses its dev build and `@testing-library/react`'s `act` works)

## Key Files

| File | Purpose |
|------|---------|
| `server.ts` | Express app entry, wires all route factories |
| `database-postgresql.ts` | All DB queries (~1557 lines) |
| `lib/redis-cache.ts` | Redis caching, PG NOTIFY listener, version management |
| `src/main.tsx` | Frontend SPA entry |
| `src/app/App.tsx` | React app shell (hash routing, role-gated nav) |
| `config/env.ts` | Typed config, validates required secrets |
| `middleware/auth.ts` | JWT auth, role-based access |
| `middleware/csrf.ts` | CSRF protection, HMAC-derived secrets |
| `worker.ts` | FCM BullMQ background worker |
| `vite.config.ts` | Vite 8 config, subpath deployment support |
| `vitest.config.ts` | Standalone test config (isolated env) |
| `ecosystem.config.cjs` | PM2 cluster configuration |

## Route Modules

Each file in `routes/` exports a factory function. New routes follow the same pattern — export `createXxxRouter()` accepting `routeCtx` deps.

| Route file | Domain |
|------------|--------|
| `auth-inline.ts` | Login, logout, auth status |
| `players.ts` | Player CRUD |
| `seasons.ts` | Season CRUD, end/reactivate |
| `matches.ts` | Match CRUD, bulk-create, image parsing, play dates |
| `rankings.ts` | Lifetime, season, date rankings |
| `cups.ts` | Cup tournament management |
| `export.ts` | Excel export |
| `admin.ts` | Admin dashboard, FCM control |
| `backup.ts` | JSON backup/restore, clear data |
| `health.ts` | Health checks, cache stats |
| `system.ts` | CSRF token, data version, SSE, config debug |
| `users.ts` | User CRUD, password change |
| `devices.ts` | FCM token registration |
| `images.ts` | Site image management (upload, preview, delete) |
