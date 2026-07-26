# Tennis Ranking System

Full-stack web application for managing tennis doubles and singles matches, rankings, cup tournaments, and seasons. Built with Express 5, PostgreSQL 15, Redis 7, and a vanilla-JS Vite SPA.

## Features

- **Players** — CRUD management with per-season rosters and lifetime statistics
- **Matches** — Doubles (2v2) and singles (1v1) with manual partner selection, bulk creation, and AI-powered screenshot parsing via OpenAI vision
- **Rankings** — Point-based system (4 pts win / 1 pt loss) with per-season, per-date, and lifetime views; real-time SSE updates
- **Seasons** — Multi-season support with auto-end by date, configurable loss penalty, final results text, and conclusion images
- **Cup Tournaments** — Single-elimination brackets with seed management, auto-generated fixtures, bye handling, score entry, and winner advancement
- **Image Editor** — Admin self-service interface for managing site images (banner, logo, favicon, background)
- **Export** — Excel export for rankings and matches (streaming for large datasets)
- **Backup** — Full JSON backup/restore with clear-all option
- **Push Notifications** — FCM push notifications via BullMQ background worker
- **Security** — signed JWTs in Secure HttpOnly SameSite cookies, rotating one-time refresh sessions, HMAC-derived CSRF protection, bcrypt, strict Helmet CSP, Redis-backed rate limiting, and server-side revocation

## Quick Start

### Prerequisites

- Node.js 22
- Docker & Docker Compose (for PostgreSQL + Redis)

### 1. Set up environment

```bash
cp .env.example .env
# Edit .env — at minimum set DB_PASSWORD, ADMIN_*, EDITOR_*, JWT_SECRET, CSRF_SECRET
```

Generate secrets:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2. Start database services

```bash
docker compose up -d postgres redis
```

### 3. Install dependencies & run

```bash
npm install
npm run dev-full          # Vite HMR (5173) + Express (3001) via concurrently
```

Frontend: `http://localhost:5173` | API: `http://localhost:3001`

### Docker (FCM Worker)

The FCM background worker runs in Docker alongside PostgreSQL and Redis:

```bash
docker compose up -d       # starts postgres, redis, and tennis-worker
```

The main app runs on the host via PM2 (see [Deployment](#deployment)).

## Deployment

| Mode | Command | Notes |
|------|---------|-------|
| **PM2 cluster** | `npm run build && pm2 start ecosystem.config.cjs --env production` | 2 workers. Requires external PG + Redis. Use `./scripts/start-with-redis.sh` when Redis is in Docker. |
| **Docker (worker)** | `docker compose up -d` | PostgreSQL + Redis + FCM worker. App runs on host via PM2. |
| **Bare node** | `NODE_ENV=production node server.js` | Single process. |
| **Dev** | `npm run dev-full` | Vite HMR + Express via concurrently. |

### Subpath Deployment

The default production subpath is `/tennis/`. Override with `BASE_PATH`:

```bash
npm run deploy:subpath     # BASE_PATH=/tennis/
npm run deploy:subdomain   # BASE_PATH=/
```

## Project Structure

```
├── config/
│   ├── env.js               # Typed config, validates required secrets at boot
│   └── cookie.js            # Cookie helpers (clearCookieAllPaths)
├── lib/
│   ├── redis-cache.js       # Redis cache (24h TTL, stampede protection, LISTEN/NOTIFY)
│   ├── jwt-encryption.js    # JWT signing/verification and legacy-token migration
│   ├── push-sender.js       # FCM push sender (topic-based)
│   ├── notification-queue.js # BullMQ-based FCM notification queue
│   ├── security-helpers.js  # Timing-safe compare, CSRF derivation
│   └── ai-parser.js         # OpenAI vision API for match screenshot parsing
├── middleware/
│   ├── auth.js              # JWT auth, role-based access
│   ├── csrf.js              # Global CSRF protection (HMAC-derived)
│   ├── compression.js       # Brotli + gzip compression
│   └── rate-limiter.js      # Redis-backed dynamic rate limiting
├── routes/
│   ├── players.js           # Player CRUD
│   ├── seasons.js           # Season CRUD, end/reactivate, final results
│   ├── matches.js           # Match CRUD, bulk-create, image parsing, play dates
│   ├── rankings.js          # Lifetime, season, date rankings
│   ├── cups.js              # Cup tournament CRUD, brackets, scores, participants
│   ├── images.js            # Site image upload/preview/metadata, season conclusion images
│   ├── export.js            # Excel export (rankings, matches, seasons)
│   ├── admin.js             # Admin: access stats, logs, IP analysis, security dashboard, FCM
│   ├── backup.js            # JSON backup/restore, clear all data
│   ├── health.js            # Health checks, performance, cache stats
│   ├── system.js            # CSRF token, data version, SSE events, config debug
│   ├── users.js             # User CRUD, password change
│   ├── auth-inline.js       # Login, logout, refresh, status inline routes
│   ├── devices.js           # FCM token registration
│   └── ...
├── utils/
│   ├── async-handler.js     # Async route wrapper, error codes, timeout middleware
│   ├── excel-helper.js      # Excel export (write-excel-file)
│   └── stream-helper.js     # JSON/Excel streaming via pg-cursor
├── migrations/              # Database migrations (idempotent, apply in order)
├── src/                     # Frontend (Vite SPA, modular vanilla JS)
│   ├── main.js              # App bootstrap
│   ├── style.css            # Global styles
│   ├── modules/             # Cross-cutting modules (api-client, auth, cache, SSE, CSRF, ...)
│   ├── features/            # Feature modules (accounts, cups, export, images, matches, ...)
│   └── lib/                 # Shared frontend utilities
├── public/                  # Static assets
├── server.js                # Express app entry (thin orchestration layer)
├── database-postgresql.js   # PostgreSQL adapter (all queries)
├── worker.js                # FCM background worker (BullMQ)
├── docker-compose.yml       # PostgreSQL + Redis + FCM worker
├── Dockerfile               # Node 22 Alpine (FCM worker image)
├── ecosystem.config.cjs     # PM2 cluster configuration (2 workers)
├── vite.config.js           # Vite 8 config (Rolldown, subpath deployment)
└── package.json
```

## API Reference

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/login` | Login, returns httpOnly JWT cookies |
| `POST` | `/api/auth/logout` | Logout, invalidate tokens |
| `GET` | `/api/auth/status` | Check auth status |

### Players

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/players` | Optional | List all players (cached) |
| `POST` | `/api/players` | Admin | Create player |
| `DELETE` | `/api/players/:id` | Admin | Delete player |

### Seasons

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/seasons` | Optional | List all seasons |
| `GET` | `/api/seasons/active` | Optional | List active seasons |
| `GET` | `/api/seasons/active-one` | Optional | Get single active season |
| `GET` | `/api/seasons/:id/players` | Optional | Get players in a season |
| `POST` | `/api/seasons` | Admin | Create season |
| `PUT` | `/api/seasons/:id` | Admin | Update season |
| `PUT` | `/api/seasons/:id/results` | Admin | Update final results text |
| `POST` | `/api/seasons/:id/end` | Admin | End season |
| `POST` | `/api/seasons/:id/reactivate` | Admin | Reactivate season |
| `DELETE` | `/api/seasons/:id` | Admin | Delete season |

### Matches

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/matches` | Optional | List matches (with filters) |
| `GET` | `/api/matches/by-date/:date` | Optional | Get matches by date |
| `GET` | `/api/matches/by-season/:seasonId` | Optional | Get matches by season |
| `GET` | `/api/matches/:id` | Optional | Get single match |
| `POST` | `/api/matches` | Editor+ | Create match |
| `PUT` | `/api/matches/:id` | Editor+ | Update match |
| `DELETE` | `/api/matches/:id` | Editor+ | Delete match |
| `GET` | `/api/matches/play-dates/list` | Optional | List all play dates |
| `GET` | `/api/matches/play-dates/latest` | Optional | Get latest play date |
| `POST` | `/api/matches/bulk-create` | Editor+ | Create multiple matches |
| `POST` | `/api/matches/parse-image` | Editor+ | Parse match from image (AI) |

### Rankings

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/rankings/lifetime` | Optional | Lifetime rankings |
| `GET` | `/api/rankings/season/:seasonId` | Optional | Season rankings |
| `GET` | `/api/rankings/date/:date` | Optional | Rankings by date |

### Cup Tournaments

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/cups` | Optional | List all cups |
| `GET` | `/api/cups/:id` | Optional | Get cup detail with bracket |
| `POST` | `/api/cups` | Admin | Create cup |
| `PUT` | `/api/cups/:id` | Admin | Update cup |
| `DELETE` | `/api/cups/:id` | Admin | Delete cup |
| `POST` | `/api/cups/:id/participants` | Admin | Add participants |
| `PUT` | `/api/cups/:id/seeds/reorder` | Admin | Reorder seeds |
| `POST` | `/api/cups/:id/generate-bracket` | Admin | Generate knockout bracket |
| `PUT` | `/api/cups/:id/matches/:mid` | Admin | Update match score |
| `PUT` | `/api/cups/:id/status` | Admin | Transition cup status |

### Images

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/images` | Admin | List site images |
| `GET` | `/api/images/:key/file` | Optional | Get image file (cached) |
| `POST` | `/api/images/:key` | Admin | Upload image |
| `PUT` | `/api/images/:key/meta` | Admin | Update image metadata |
| `DELETE` | `/api/images/:key` | Admin | Deactivate image |
| `POST` | `/api/images/season/:seasonId/conclusion` | Admin | Upload season conclusion image |
| `GET` | `/api/images/season/:seasonId/conclusion/file` | Optional | Get conclusion image |
| `DELETE` | `/api/images/season/:seasonId/conclusion` | Admin | Delete conclusion image |

### Export

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/export-excel` | Auth | Export current rankings |
| `GET` | `/api/export-excel/date/:date` | Auth | Export rankings by date |
| `GET` | `/api/export-excel/season/:seasonId` | Auth | Export season rankings |
| `GET` | `/api/export-excel/lifetime` | Auth | Export lifetime rankings |

### Admin

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/admin/access-stats` | Admin | Access statistics |
| `GET` | `/api/admin/access-logs` | Admin | Access logs |
| `GET` | `/api/admin/ip-analysis` | Admin | IP analysis |
| `GET` | `/api/admin/active-sessions` | Admin | Active sessions |
| `GET` | `/api/admin/security-dashboard` | Admin | Security dashboard |
| `GET` | `/api/admin/fcm/status` | Admin | FCM push status |
| `POST` | `/api/admin/fcm/pause` | Admin | Pause FCM pushes |
| `POST` | `/api/admin/fcm/resume` | Admin | Resume FCM pushes |
| `POST` | `/api/admin/fcm/send` | Admin | Send FCM push notification |

### Backup

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/backup` | Admin | Full JSON backup |
| `POST` | `/api/restore` | Admin | Restore from backup |
| `DELETE` | `/api/backup/clear-all-data` | Admin | Clear all data |

### Health & System

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check (Docker HEALTHCHECK) |
| `GET` | `/api/health` | Detailed health info |
| `GET` | `/api/performance` | Performance metrics |
| `GET` | `/api/cache-stats` | Redis cache statistics |
| `GET` | `/api/init` | Bootstrap data for frontend |
| `GET` | `/api/events` | SSE real-time updates |
| `GET` | `/api/data-version` | Server data version |
| `GET` | `/api/csrf-token` | Get CSRF token |

### Users

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/users` | Admin | List all users |
| `POST` | `/api/users` | Admin | Create user |
| `PUT` | `/api/users/:id` | Admin | Update user |
| `PUT` | `/api/users/:id/password` | Admin | Change user password |
| `DELETE` | `/api/users/:id` | Admin | Delete user |

### Devices (FCM)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/devices/register` | Editor+ | Register FCM token |

## Architecture

### System Overview

```
┌──────────┐     ┌─────────────┐     ┌──────────┐     ┌──────────┐
│  Browser  │◄──►│  Express    │◄──►│PostgreSQL│◄──►│  Redis   │
│  (Vite)  │ SSE │  (server.js)│     │  (PG15)  │     │  (R7)    │
└──────────┘     └──────┬──────┘     └──────────┘     └─────┬────┘
                         │                                    │
                         ▼                                    ▼
                  ┌─────────────┐                      ┌─────────────┐
                  │   BullMQ   │◄─────────────────────│  (Queue)   │
                  │  (Queue)   │                      └─────────────┘
                  └──────┬──────┘
                         ▼
                  ┌─────────────┐
                  │   Firebase  │
                  │   (FCM)    │
                  └─────────────┘
```

### Three-Tier Cache

1. **PostgreSQL** — source of truth, with `NOTIFY` triggers on data mutations
2. **Redis** — 24h TTL, stampede protection via distributed locks, preloads startup keys on boot. Subscribes to PG `LISTEN/NOTIFY` for invalidation
3. **Client** — type-specific TTLs (rankings 2m, matches 1m, players 10m). Polls SSE + data version to invalidate

### Cache Invalidation Flow

```
DB mutation → PG trigger → pg_notify('cache_invalidation')
  → Redis cache invalidated → SSE broadcast to all clients
  → Client cache invalidated → Next poll fetches fresh data
```

### Router Factory Pattern

Every route module exports a factory; dependencies are injected, not imported. This keeps `server.js` as the single wiring point.

```javascript
export const createPlayerRouter = ({ db, checkAuth, rankingsCache }) => {
  const router = Router()
  router.get('/', checkAuth, asyncHandler(async (req, res) => {
    const { data } = await rankingsCache.getOrSet('players', () => db.getPlayers())
    res.json(sanitizeResponse(data))
  }))
  return router
}
```

### Auth & Security

- **JWT**: RS256 when configured (HS256 fallback), 15m access / 7d rotating refresh sessions, stored in Secure HttpOnly cookies
- **CSRF**: HMAC-derived secret per user ID + double-submit token via `X-CSRF-Token` header
- **Roles**: `admin` (full CRUD), `editor` (match edits + FCM registration)
- **Helmet**: Strict CSP, HSTS, Permissions-Policy, frameguard deny
- **Rate limiting**: Redis-backed with dynamic scaling when CPU > 80% or RAM > 85%
- **Token versioning**: Server-side JWT revocation on logout/password change

### Frontend Architecture

Modular vanilla-JS SPA organized into:

- **`src/modules/`** — cross-cutting concerns: API client, app state, auth manager, cache manager, CSRF handler, SSE manager, tab manager, UI helpers
- **`src/features/`** — domain modules: accounts, cups, export, images, matches, players, rankings, seasons

## Configuration

### Required Environment Variables

The following are **required at startup** — the server exits if any are missing:

`ADMIN_USERNAME`, `ADMIN_PASSWORD`, `EDITOR_USERNAME`, `EDITOR_PASSWORD`, `JWT_SECRET`, `CSRF_SECRET`

See [`.env.example`](.env.example) for the full list of all variables (database, Redis, rate limiting, cache, CORS, AI parser, FCM, etc.).

## Testing

```bash
npm test              # Run all tests (vitest)
npm run test:unit     # Unit tests only
npm run test:watch    # Watch mode
npm run test:cors     # Quick CORS check via curl
```

## Common Commands

```bash
npm install                       # Install dependencies
docker compose up -d postgres redis  # Start DB services
npm run dev-full                  # Dev: Vite + Express
npm run build                     # Build frontend to dist/
npm run server                    # Run Express server
npm start                         # Build + server
npm run deploy:production         # Production build + server
npm run health-check              # GET /health
```

## Database

Key tables: `players`, `seasons`, `season_players`, `matches`, `users`, `devices`, `cups`, `cup_matches`, `cup_advancements`, `site_images`, `player_lifetime_stats`, `player_season_stats`.

Migrations are idempotent shell scripts in `migrations/`. Apply in numerical order. Pre-computed stats tables are auto-updated via PostgreSQL triggers on match CRUD.

## Troubleshooting

- **ESM only** — use `import/export`, never `require()`
- **Subpath** — production default is `/tennis/`. Override with `BASE_PATH` env var
- **Cookies** — always clear via `clearCookieAllPaths(res, name)` due to historical path variations
- **`/api/init` is never cached** — it carries per-user auth state
- **SSE** — request timeout middleware skips `/api/events`; max 1000 clients by default
- **PM2 + Docker Redis race** — use `./scripts/start-with-redis.sh` when Redis runs in Docker with host port mapping

## License

This project is created for personal/commercial use.
