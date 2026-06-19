# Tennis Doubles Ranking System

A full-stack web application for managing tennis doubles (and singles) matches, rankings, and seasons. Built with vanilla JavaScript (Vite), Express, PostgreSQL, and Redis.

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [API Reference](#api-reference)
- [Architecture](#architecture)
- [Security](#security)
- [Deployment](#deployment)
- [Database Schema](#database-schema)
- [Configuration](#configuration)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

---

## Features

### 🎾 Player Management
- Add, edit, and remove players dynamically
- Per-season player rosters (`season_players` junction table)
- Player statistics: wins, losses, points, money lost, recent form

### 🏆 Match Recording
- **Doubles (duo)**: 2v2 matches
- **Singles (solo)**: 1v1 matches
- **Manual partner selection**: Players choose their own partners
- **Score tracking** with winner/loser selection
- **Image parsing**: AI-powered match screenshot parsing via OpenAI vision API
- **Bulk creation**: Create multiple matches at once
- **Play date management**: Group matches by date, get latest dates

### 📊 Ranking System
- **Point-based ranking**: Winners get 4 points, losers get 1 point
- **Multi-season support**: Track rankings per season, by date, and lifetime
- **Form tracking**: Recent win/loss streaks (last 5 matches)
- **Money tracking**: Configurable loss penalty (default 20,000 VND) per season
- **Pre-computed stats**: `player_lifetime_stats` and `player_season_stats` tables with auto-updating triggers
- **Real-time updates**: Rankings update via SSE (Server-Sent Events) push

### 📅 Season Management
- Multiple concurrent active seasons
- Auto-end by date, manual end/reactivate
- Per-season player rosters and configurable loss penalty
- Season backup before migration

### 📁 Export & Backup
- **Excel export**: Rankings, matches, and statistics to `.xlsx` (streaming for large datasets)
- **JSON backup/restore**: Full database backup including users
- **Date/season/lifetime** export modes
- **Clear all data**: Admin-only endpoint to reset the database

### 🔒 Security
- JWT authentication (HS256, 15m access / 7d refresh) encrypted with **AES-256-GCM** in httpOnly cookies
- CSRF protection: HMAC-derived secret per session-id cookie + double-submit token
- bcrypt password hashing (14 rounds)
- Role-based access: `admin` (full CRUD), `editor` (match edits only), `viewer` (read-only)
- Helmet with strict CSP, HSTS, Permissions-Policy, frameguard deny
- Redis-backed rate limiting with dynamic scaling (CPU/RAM-aware)
- Token versioning for server-side JWT revocation

### 🔔 Push Notifications
- FCM (Firebase Cloud Messaging) push notifications via BullMQ queue
- FCM token registration and management
- Topic-based push sending (fire-and-forget)
- Pause/resume/sent status for FCM campaigns

---

## Quick Start

### Option 1: Docker (Recommended)

```bash
# Copy and configure environment variables
cp .env.example .env

# Start full stack (app + PostgreSQL + Redis)
docker compose up -d
```

The app will be available at `http://localhost:3001`.

### Option 2: Local Development

```bash
# Start database services only
docker compose up -d postgres redis

# Install dependencies
npm install

# Configure environment
cp .env.example .env

# Start dev servers (Vite HMR + Express concurrently)
npm run dev-full
```

Frontend: `http://localhost:5173` | API: `http://localhost:3001`

### Option 3: PM2 (Production)

```bash
npm run build
pm2 start ecosystem.config.cjs --env production
```

### Database Setup (Standalone)

For setting up PostgreSQL/Redis without the app:

```bash
# Interactive setup (local or Docker PostgreSQL)
./setup.sh setup

# Or run all steps: DB + migrations
./setup.sh all
```

See [setup.sh](setup.sh) for full documentation.

---

## Project Structure

```
├── config/                  # Environment & cookie configuration
│   ├── env.js               # Typed config, validates required secrets
│   └── cookie.js            # Cookie helpers (clearCookieAllPaths)
├── lib/                     # Core libraries
│   ├── redis-cache.js       # Redis caching (24h TTL, stampede protection, NOTIFY)
│   ├── jwt-encryption.js    # AES-256-GCM JWT encryption/decryption
│   ├── push-sender.js       # FCM push sender (topic-based)
│   ├── notification-queue.js# BullMQ-based FCM notification queue
│   ├── security-helpers.js  # Timing-safe compare, CSRF derivation, session mgmt
│   └── ai-parser.js         # OpenAI vision API for match screenshot parsing
├── middleware/              # Express middleware
│   ├── auth.js              # JWT auth, role-based access
│   ├── csrf.js              # Global CSRF protection (HMAC-derived)
│   ├── compression.js       # Custom Brotli + gzip compression
│   └── rate-limiter.js      # Redis-backed dynamic rate limiting
├── routes/                  # API route modules (each exports a factory)
│   ├── players.js           # Player CRUD
│   ├── seasons.js           # Season CRUD, check-expired, active seasons
│   ├── matches.js           # Match CRUD, bulk-create, image parsing, play dates
│   ├── rankings.js          # Lifetime, season, date rankings
│   ├── export.js            # Excel export (rankings, matches, seasons)
│   ├── admin.js             # Admin: access stats, logs, IP analysis, security dashboard, FCM
│   ├── backup.js            # JSON backup/restore, clear all data
│   ├── health.js            # Health checks, performance, cache stats
│   ├── system.js            # CSRF token, data version, SSE events, config debug
│   ├── users.js             # User CRUD, password change
│   └── devices.js           # FCM token registration
├── utils/                   # Utility modules
│   ├── async-handler.js     # Async route wrapper, error codes, timeout middleware
│   ├── excel-helper.js      # Excel export (write-excel-file)
│   └── stream-helper.js     # JSON/Excel streaming via pg-cursor
├── worker.js                # FCM background worker (BullMQ queue processor)
├── migrations/              # Database migrations (idempotent)
│   ├── add-performance-indexes.sql  # Performance indexes
│   ├── add-match-details-view.sql   # match_details view + updated_at triggers
│   └── ...                  # Application migrations
├── tests/                   # Vitest test suite
├── src/                     # Frontend (Vite SPA)
│   ├── main.js              # Frontend SPA (~4000 lines, vanilla JS)
│   └── style.css            # Global styles
├── public/                  # Static assets
├── server.js                # Express app entry point (~687 lines)
├── database-postgresql.js   # Database adapter (~1557 lines)
├── worker.js                # FCM background worker (BullMQ)
├── docker-compose.yml       # Full-stack Docker (app + PG + Redis)
├── Dockerfile               # Multi-stage Node 22 Alpine build
├── ecosystem.config.cjs     # PM2 cluster configuration
├── setup.sh                 # Unified setup + migration script
├── .env.example             # Environment variable template
├── vite.config.js           # Vite 8 config (subpath deployment)
└── package.json             # Dependencies and scripts
```

---

## API Reference

### Authentication

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/auth/login` | No | Login, returns httpOnly JWT cookies |
| `POST` | `/api/auth/logout` | Yes | Logout, invalidate tokens |
| `GET` | `/api/auth/status` | Optional | Check auth status |

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
| `POST` | `/api/seasons/:id/end` | Admin | End season |
| `POST` | `/api/seasons/:id/reactivate` | Admin | Reactivate season |
| `DELETE` | `/api/seasons/:id` | Admin | Delete season |
| `GET` | `/api/seasons/check-expired` | Admin | Check expired seasons |

### Matches

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/matches` | Optional | List matches (with filters) |
| `GET` | `/api/matches/by-date/:date` | Optional | Get matches by date |
| `GET` | `/api/matches/by-season/:seasonId` | Optional | Get matches by season |
| `GET` | `/api/matches/:id` | Optional | Get single match |
| `POST` | `/api/matches` | Editor | Create match |
| `PUT` | `/api/matches/:id` | Editor | Update match |
| `DELETE` | `/api/matches/:id` | Editor | Delete match |
| `GET` | `/api/matches/play-dates/list` | Optional | List all play dates |
| `GET` | `/api/matches/play-dates/latest` | Optional | Get latest play date |
| `POST` | `/api/matches/bulk-create` | Editor | Create multiple matches |
| `POST` | `/api/matches/parse-image` | Editor | Parse match from image (AI) |

### Rankings

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/rankings/lifetime` | Optional | Lifetime rankings |
| `GET` | `/api/rankings/season/:seasonId` | Optional | Season rankings |
| `GET` | `/api/rankings/date/:date` | Optional | Rankings by date |

### Export (Excel)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/export` | Auth | Export rankings (current) |
| `GET` | `/api/export/date/:date` | Auth | Export rankings by date |
| `GET` | `/api/export/season/:seasonId` | Auth | Export season rankings |
| `GET` | `/api/export/lifetime` | Auth | Export lifetime rankings |

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
| `GET` | `/api/backup-data` | Admin | Backup data only |
| `POST` | `/api/restore` | Admin | Restore from backup |
| `POST` | `/api/restore-data` | Admin | Restore data only |
| `DELETE` | `/api/backup/clear-all-data` | Admin | Clear all data |

### Health & System

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/health` | No | Health check (Docker HEALTHCHECK) |
| `GET` | `/api/health` | No | Detailed health info |
| `GET` | `/api/performance` | No | Performance metrics |
| `GET` | `/api/cache-stats` | No | Redis cache statistics |
| `GET` | `/api/init` | Optional | Bootstrap data for frontend (never cached) |
| `GET` | `/api/csrf-token` | No | Get CSRF token |
| `POST` | `/api/csrf-token` | No | Request CSRF token |
| `GET` | `/api/data-version` | No | Server data version (polling) |
| `GET` | `/api/events` | No | SSE real-time updates (no timeout) |
| `POST` | `/api/csp-report` | No | CSP violation report endpoint |
| `GET` | `/api/debug/config` | Admin | Debug configuration |

### Users

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/users` | Admin | List all users |
| `POST` | `/api/users` | Admin | Create user |
| `GET` | `/api/users/:id` | Admin | Get single user |
| `PUT` | `/api/users/:id` | Admin | Update user |
| `PUT` | `/api/users/:id/password` | Admin | Change user password |
| `DELETE` | `/api/users/:id` | Admin | Delete user |

### Devices (FCM)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/devices/register` | Editor | Register FCM token |

---

## Architecture

### System Overview

```
┌──────────┐     ┌─────────────┐     ┌──────────┐     ┌──────────┐
│  Browser  │◄──►│  Express    │◄──►│PostgreSQL│◄──►│  Redis   │
│  (Vite)  │ SSE │  (server.js)│     │  (PG15)  │     │  (R7)    │
└──────────┘     └──────┬──────┘     └──────────┘     └──────────┘
                         │
                         ▼
                  ┌─────────────┐
                  │   BullMQ   │
                  │  (Queue)   │
                  └──────┬──────┘
                         ▼
                  ┌─────────────┐
                  │   Firebase  │
                  │   (FCM)    │
                  └─────────────┘
```

### Three-Tier Cache

1. **PostgreSQL** — source of truth, with `NOTIFY` triggers on data mutations.
2. **Redis** (`lib/redis-cache.js`) — 24h TTL, stampede protection via distributed locks, preloads startup keys (`rankings:lifetime`, `players`, `seasons`, etc.) on boot. Subscribes to PG `LISTEN/NOTIFY` for invalidation; emits `versionChange` events.
3. **Client** (`src/main.js`) — type-specific TTLs (rankings 2m, matches 1m, players 10m, version-poll 30s). Polls `/api/events` SSE + server data version to invalidate.

### Cache Invalidation Flow

```
DB mutation → PG trigger → pg_notify('cache_invalidation')
  → Redis cache invalidated → SSE broadcast to all clients
  → Client cache invalidated → Next poll fetches fresh data
```

### Router Factory Pattern

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

### SSE (Server-Sent Events)

- Real-time updates via `/api/events` (no request timeout).
- `server.js` listens to `rankingsCache.on('versionChange', ...)` and fans out to all SSE clients.
- Cache headers (`ETag: W/"v-{version}"`) on `/api` GETs enable 304s.
- Default max 1000 SSE clients (`MAX_SSE_CLIENTS`).

### Auth & Security

- **JWT**: HS256, 15m access / 7d refresh, encrypted with **AES-256-GCM** in httpOnly cookies.
- **CSRF**: HMAC-derived secret per session-id cookie + double-submit token. Required on all non-GET requests via `X-CSRF-Token` header.
- **bcrypt**: 14 rounds.
- **Helmet**: Strict CSP, HSTS, Permissions-Policy, frameguard deny.
- **Rate limiting**: Redis-backed with dynamic scaling when CPU>80% or RAM>85%.
- **Token versioning**: `token_version` column on `users` for server-side JWT revocation on logout/password change.

### Two Auth Tiers

- `admin` — full CRUD access (players, seasons, matches, users, system config).
- `editor` — match edits only (create, update, delete matches).

---

## Deployment

| Mode | Command | Notes |
|------|---------|-------|
| **Docker** | `docker compose up -d` | Full stack (app + PG + Redis), recommended. `pm2-runtime` inside container, `dumb-init` PID 1. |
| **PM2 cluster** | `npm run build && pm2 start ecosystem.config.cjs --env production` | Requires external PG + Redis. Cluster mode, 2 workers by default. |
| **Bare node** | `NODE_ENV=production node server.js` | Single process. |
| **Dev** | `npm run dev-full` | Vite HMR + Express. |

PM2/cluster is safe because: rate limits use Redis (`rate-limit-redis-tennis:<name>`), each worker subscribes to PG `LISTEN/NOTIFY` for SSE, and the data version uses a Redis version-lock so all workers broadcast the same version number.

### Deployment Modes

| Mode | Command | Notes |
|------|---------|-------|
| Docker | `docker compose up -d` | App + PG + Redis, recommended. |
| PM2 cluster | `npm run build && pm2 start ecosystem.config.cjs --env production` | Requires external PG + Redis. |
| Bare node | `NODE_ENV=production node server.js` | Single process. |
| Dev | `npm run dev-full` | Vite HMR + Express. |

### Subpath Deployment

Default production subpath is `/tennis/`. Set `SUBPATH` (or `BASE_PATH`) env var.

```bash
# Build for subpath
npm run build:subpath

# Deploy for subpath
npm run deploy:subpath

# Build for root domain
npm run build:subdomain

# Deploy for root domain
npm run deploy:subdomain
```

---

## Database Schema

Key tables managed through `database-postgresql.js` (~1557 lines):

| Table | Description |
|-------|-------------|
| `players` | Player records (name, created_at, updated_at) |
| `seasons` | Seasons (name, start_date, end_date, auto_end, description, ended_at, ended_by, lose_money_per_loss) |
| `season_players` | Junction table: which players belong to which seasons |
| `matches` | Match records (player1-4, winning_team, play_date, season_id, match_type: duo/solo) |
| `users` | User accounts (username, password_hash, role, token_version) |
| `devices` | FCM device tokens (user_id, token, platform) |
| `player_lifetime_stats` | Pre-computed lifetime stats (auto-updated by trigger) |
| `player_season_stats` | Pre-computed per-season stats (auto-updated by trigger) |

### Indexes

Performance indexes are created by `migrations/add-performance-indexes.sql`:
- `idx_matches_season_id` — fast season filtering
- `idx_matches_play_date` — fast date-range queries
- `idx_matches_player1_id`, `idx_matches_player2_id`, etc. — fast player lookups
- `idx_seasons_start_date`, `idx_seasons_end_date` — date range queries
- `idx_season_players_player_id`, `idx_season_players_season_id` — junction lookups

### Views

- `match_details` — Enriched match view with player names, season info.

### Triggers

- `matches_cache_invalidation` — Notifies Redis cache on match changes.
- `players_cache_invalidation` — Notifies Redis cache on player changes.
- `seasons_cache_invalidation` — Notifies Redis cache on season changes.
- `trg_matches_ranking_stats` — Auto-updates `player_lifetime_stats` and `player_season_stats` on match CRUD.

---

## Configuration

### Required Environment Variables

`ADMIN_USERNAME`, `ADMIN_PASSWORD`, `EDITOR_USERNAME`, `EDITOR_PASSWORD`, `JWT_SECRET`, `CSRF_SECRET` are **all required at startup** — `config/env.js` calls `process.exit(1)` if any are missing.

Generate secrets:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # CSRF_SECRET
```

### All Environment Variables

See [`.env.example`](.env.example) for the full list. Key groups:

| Group | Variables |
|-------|-----------|
| **Database** | `DB_TYPE`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` |
| **Redis** | `REDIS_URL` |
| **Auth** | `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `EDITOR_USERNAME`, `EDITOR_PASSWORD` |
| **Security** | `JWT_SECRET`, `CSRF_SECRET`, `BCRYPT_ROUNDS` (default 14) |
| **Rate Limiting** | `RATE_LIMIT_*` (requests per window, window size, CPU/RAM thresholds) |
| **CORS** | `ALLOWED_ORIGINS` (comma-separated) |
| **Cache** | `CACHE_TTL` (default 24h) |
| **Server** | `PORT` (default 3001), `SUBPATH` / `BASE_PATH` (default `/tennis/`) |
| **SSE** | `MAX_SSE_CLIENTS` (default 1000) |
| **AI Parser** | `AI_API_KEY`, `AI_API_URL`, `AI_MODEL` |
| **FCM** | `GOOGLE_APPLICATION_CREDENTIALS` (path to service account JSON) |

---

## Testing

```bash
npm test              # Run all tests
npm run test:unit     # Unit tests only
npm run test:watch    # Watch mode
npm run test:cors     # Quick CORS check via curl
```

---

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

# Health / diagnostics
npm run health-check      # GET /health
```

---

## Troubleshooting

### Gotchas

- **ESM only** — use `import/export`, never `require()`. Node 20.
- **Subpath** — production default is `/tennis/`. Set `SUBPATH` (or `BASE_PATH`) env var. Static serving and API normalization both honor it.
- **Cookies** — always clear via `clearCookieAllPaths(res, name)` (not `res.clearCookie`) due to historical path variations.
- **`/api/init` is never cached** — it carries per-user auth state. Other auth routes skip the ETag middleware.
- **SSE** — request timeout middleware explicitly skips `/api/events`; set `MAX_SSE_CLIENTS` (default 1000).
- **Trust proxy** — auto-on in production. Off in dev. Affects `req.ip` and rate-limit keying.
- **CSRF secret derivation** — `HMAC-SHA256(CSRF_SECRET, sessionId)`. The session-id cookie is the only thing stored; the secret is never persisted.

### Critical Patterns

**After every mutation, invalidate cache:**
```javascript
await rankingsCache.invalidateOnPlayerChange()
await rankingsCache.invalidateOnMatchChange(playDate)
await rankingsCache.invalidateOnSeasonChange()
```

**Always wrap async routes:**
```javascript
asyncHandler(async (req, res) => { ... })
```

**Validate input:**
```javascript
use([body('name').trim().escape()])
```

---

## License

This project is created for personal/commercial use.
