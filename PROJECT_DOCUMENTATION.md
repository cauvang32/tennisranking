# Tennis Doubles Ranking System — Complete Documentation

> Full-stack web app for managing tennis doubles/singles rankings with multi-season support, point-based ranking (4 winner / 1 loser), money penalties, real-time SSE updates, and FCM push notifications.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Technology Stack](#technology-stack)
3. [Database Schema](#database-schema)
4. [API Reference](#api-reference)
5. [Cache System](#cache-system)
6. [Authentication & Security](#authentication--security)
7. [Frontend Architecture](#frontend-architecture)
8. [Deployment](#deployment)
9. [Configuration](#configuration)

---

## Architecture Overview

```
┌─────────────┐     HTTPS      ┌──────────────────────────────────────────┐
│   Browser    │ ◄──────────► │  Nginx (optional reverse proxy)          │
│  (SPA)       │              │  /tennis/ → static files                 │
└─────────────┘              └──────────────┬───────────────────────────┘
                                             │
                                    ┌────────▼────────┐
                                    │  Express.js     │
                                    │  :3001          │
                                    ├─────────────────┤
                                    │ Routes (factory)│
                                    │ Middleware      │
                                    │ SSE broadcaster │
                                    └──┬──────┬──────┬┘
                                       │      │      │
                              ┌────────▼┐  ┌──▼──┐  │
                              │PostgreSQL│ │Redis│  │
                              │  :5432  │ │:6379│  │
                              └─────────┘ └─────┘  │
                                                   │
                                            ┌──────▼──────┐
                                            │ FCM Worker   │
                                            │ (worker.js)  │
                                            └─────────────┘
```

### Data Flow

1. **Client** → Express API → PostgreSQL (primary storage) → Redis cache (with auto-invalidation) → Client cache
2. **PostgreSQL triggers** → `NOTIFY` on data mutations → Redis auto-invalidates via `LISTEN/NOTIFY`
3. **Redis version changes** → SSE broadcast to all connected clients → Client cache invalidation

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 20+ (ESM), Express.js |
| Database | PostgreSQL 15 |
| Cache | Redis 7 (with `allkeys-lru` eviction) |
| Frontend | Vanilla JS, Vite 7 |
| Auth | JWT (HS256) + AES-256-GCM encryption in httpOnly cookies |
| Push Notifications | Firebase Cloud Messaging (FCM) via BullMQ queues |
| Deployment | Docker Compose / PM2 cluster / bare Node |
| Security | Helmet, CORS, CSRF double-submit, rate limiting (Redis-backed) |

---

## Database Schema

### Tables

#### `players`

Stores player records.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | SERIAL | PRIMARY KEY, auto-increment |
| `name` | VARCHAR(255) | UNIQUE, NOT NULL |
| `created_at` | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP |

#### `seasons`

Tennis seasons with configurable parameters.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | SERIAL | PRIMARY KEY |
| `name` | VARCHAR(255) | NOT NULL |
| `start_date` | DATE | NOT NULL |
| `end_date` | DATE | NULLABLE |
| `is_active` | BOOLEAN | DEFAULT true |
| `auto_end` | BOOLEAN | DEFAULT true |
| `description` | TEXT | |
| `lose_money_per_loss` | INTEGER | DEFAULT 20000 (VND) |
| `created_at` | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP |
| `ended_at` | TIMESTAMP | NULLABLE |
| `ended_by` | VARCHAR(255) | NULLABLE |

#### `season_players`

Junction table: which players participate in which season.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | SERIAL | PRIMARY KEY |
| `season_id` | INTEGER | NOT NULL, REFERENCES seasons(id) ON DELETE CASCADE |
| `player_id` | INTEGER | NOT NULL, REFERENCES players(id) ON DELETE CASCADE |
| `added_at` | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP |
| `added_by` | VARCHAR(255) | |
| **UNIQUE** | `(season_id, player_id)` | |

#### `matches`

Match records supporting both doubles (`duo`) and singles (`solo`).

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | SERIAL | PRIMARY KEY |
| `season_id` | INTEGER | NOT NULL, REFERENCES seasons(id) |
| `play_date` | DATE | NOT NULL |
| `player1_id` | INTEGER | NOT NULL, REFERENCES players(id) |
| `player2_id` | INTEGER | REFERENCES players(id) (nullable for solo) |
| `player3_id` | INTEGER | NOT NULL, REFERENCES players(id) |
| `player4_id` | INTEGER | REFERENCES players(id) (nullable for solo) |
| `team1_score` | INTEGER | NOT NULL |
| `team2_score` | INTEGER | NOT NULL |
| `winning_team` | INTEGER | NOT NULL (1 or 2) |
| `match_type` | VARCHAR(10) | DEFAULT 'duo', CHECK IN ('solo', 'duo') |
| `created_at` | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP |

**Constraints:**
- `check_match_type`: duo requires player2_id AND player4_id; solo requires both NULL
- `check_match_players`: validates player presence based on match type

#### `users`

Application users (database-based auth, separate from env credentials).

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | BIGSERIAL | PRIMARY KEY |
| `username` | VARCHAR(255) | UNIQUE, NOT NULL |
| `email` | VARCHAR(255) | UNIQUE, nullable |
| `password_hash` | TEXT | NOT NULL |
| `role` | VARCHAR(20) | DEFAULT 'viewer', IN ('admin', 'editor', 'viewer') |
| `display_name` | VARCHAR(255) | |
| `is_active` | BOOLEAN | DEFAULT true |
| `token_version` | INTEGER | DEFAULT 0 (for token revocation) |
| `created_by` | VARCHAR(255) | |
| `notes` | TEXT | nullable |
| `receive_match_notifications` | BOOLEAN | DEFAULT false |
| `receive_season_notifications` | BOOLEAN | DEFAULT false |
| `last_login_at` | TIMESTAMP | nullable |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() |

#### `devices`

FCM push notification device registry.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | BIGSERIAL | PRIMARY KEY |
| `user_id` | BIGINT | REFERENCES users(id) ON DELETE CASCADE, nullable |
| `token` | TEXT | UNIQUE, NOT NULL (FCM token) |
| `platform` | VARCHAR(8) | CHECK IN ('android', 'ios') |
| `app_version` | VARCHAR(32) | nullable |
| `registered_ip` | INET | nullable |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() |
| `updated_at` | TIMESTAMPTZ | DEFAULT NOW() |

### Indexes

| Index | Table | Purpose |
|-------|-------|---------|
| `idx_matches_play_date` | matches | Date-based queries |
| `idx_matches_season_id` | matches | Season-scoped queries |
| `idx_matches_match_type` | matches | Filter by match type |
| `idx_matches_player1_id` through `idx_matches_player4_id` | matches | Player lookup |
| `idx_matches_season_date` | matches | Composite: season + date DESC |
| `idx_matches_form_lookup` | matches | Covering index for form queries |
| `idx_seasons_active` | seasons | Active season filtering |
| `idx_season_players_season_id` | season_players | Season player lookup |
| `idx_season_players_player_id` | season_players | Player season lookup |
| `idx_season_players_composite` | season_players | Composite lookup |
| `idx_devices_user_id` | devices | User device lookup |

### Cache Invalidation Triggers

PostgreSQL triggers on `matches`, `players`, and `seasons` tables call `notify_cache_invalidation()` which sends `pg_notify('cache_invalidation', payload)` to the Redis listener. This enables real-time cache invalidation without polling.

---

## API Reference

All API endpoints are prefixed with `/api/` (or the configured `SUBPATH`, default `/tennis/`).

### Authentication Endpoints

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| POST | `/api/auth/login` | No | — | Login, sets httpOnly cookies |
| POST | `/api/auth/logout` | Yes | Any | Logout, clears all cookies |
| GET | `/api/auth/status` | Conditional | Any | Check auth status |
| POST | `/api/auth/refresh` | Cookie (refreshToken) | Any | Refresh access token |

**Login Request:**
```json
POST /api/auth/login
{ "username": "admin", "password": "secret" }
```

**Login Response:**
```json
{
  "success": true,
  "message": "Login successful",
  "csrfToken": "...",
  "user": { "id": 1, "username": "admin", "role": "admin", "displayName": "System Admin" },
  "authMethod": "httponly_cookie"
}
```

**Token Refresh Response:**
```json
{ "success": true, "csrfToken": "...", "user": { ... } }
```

### System Endpoints

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| GET | `/api/csrf-token` | No | — | Get CSRF token (GET or POST) |
| GET | `/api/data-version` | Conditional | Any | Get server data version for cache sync |
| GET | `/api/init` | Conditional | Any | Bootstrap all initial data (never cached) |
| GET | `/api/events` | No | — | SSE endpoint for real-time updates |
| POST | `/api/csp-report` | No | — | CSP violation report |
| GET | `/api/debug/config` | Yes | Admin | Debug server configuration |

**Init Response** returns all data needed by the frontend in one call:
```json
{
  "lifetimeRankings": [...],
  "players": [...],
  "seasons": [...],
  "activeSeasons": [...],
  "playDates": [...],
  "activeSeason": {...},
  "defaultDate": "2025-01-15",
  "defaultDateRankings": [...],
  "defaultDateMatches": [...],
  "version": 1718263200000,
  "isAuthenticated": true,
  "user": {...},
  "csrfToken": "...",
  "timestamp": "..."
}
```

**SSE Events:** Server sends `data: {"type":"version","version":1718263200000}` on version changes. Keepalive every 20s.

### Players Endpoints

| Method | Path | Auth | Role | Rate Limiter | Description |
|--------|------|------|------|-------------|-------------|
| GET | `/api/players` | Conditional | Any | — | List all players |
| POST | `/api/players` | Yes | Admin | `createLimiter` | Add player |
| DELETE | `/api/players/:id` | Yes | Admin | `deleteLimiter` | Remove player |

**Create Player Request:**
```json
{ "name": "Nguyen Van A" }
```

### Seasons Endpoints

| Method | Path | Auth | Role | Rate Limiter | Description |
|--------|------|------|------|-------------|-------------|
| GET | `/api/seasons` | Conditional | Any | — | List all seasons |
| GET | `/api/seasons/active` | Conditional | Any | — | List active seasons |
| GET | `/api/seasons/active-one` | Conditional | Any | — | Get single active season |
| POST | `/api/seasons` | Yes | Admin | `createLimiter` | Create season |
| PUT | `/api/seasons/:id` | Yes | Admin | — | Update season |
| DELETE | `/api/seasons/:id` | Yes | Admin | `deleteLimiter` | Delete season |
| GET | `/api/seasons/:id/players` | Conditional | Any | — | Get players in season |
| POST | `/api/seasons/:id/players` | Yes | Editor | — | Add players to season |
| POST | `/api/seasons/:id/players/:playerId` | Yes | Editor | — | Add single player |
| DELETE | `/api/seasons/:id/players/:playerId` | Yes | Editor | — | Remove player from season |

**Create Season Request:**
```json
{
  "name": "Mùa 1 2025",
  "startDate": "2025-01-01",
  "endDate": "2025-12-31",
  "autoEnd": true,
  "description": "Season description",
  "loseMoneyPerLoss": 20000,
  "playerIds": [1, 2, 3, 4]
}
```

### Matches Endpoints

| Method | Path | Auth | Role | Rate Limiter | Description |
|--------|------|------|------|-------------|-------------|
| GET | `/api/matches` | Conditional | Any | — | List matches (with optional `?limit=N`) |
| GET | `/api/matches/:id` | Conditional | Any | — | Get single match |
| GET | `/api/matches/by-date/:date` | Conditional | Any | — | Get matches by date (YYYY-MM-DD) |
| GET | `/api/matches/by-season/:seasonId` | Conditional | Any | — | Get matches by season |
| POST | `/api/matches` | Yes | Editor | `createLimiter` | Create match |
| PUT | `/api/matches/:id` | Yes | Editor | — | Update match |
| DELETE | `/api/matches/:id` | Yes | Editor | `deleteLimiter` | Delete match |

**Create Match Request:**
```json
{
  "seasonId": 1,
  "playDate": "2025-01-15",
  "player1Id": 1,
  "player2Id": 2,
  "player3Id": 3,
  "player4Id": 4,
  "team1Score": 6,
  "team2Score": 4,
  "winningTeam": 1,
  "matchType": "duo"
}
```

### Legacy Play Dates Endpoints (frontend calls these directly)

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| GET | `/api/play-dates` | Conditional | Any | List all play dates |
| GET | `/api/play-dates/latest` | Conditional | Any | Get latest play date |

### Rankings Endpoints

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| GET | `/api/rankings/lifetime` | Conditional | Any | Lifetime rankings |
| GET | `/api/rankings/season/:seasonId` | Conditional | Any | Season rankings |
| GET | `/api/rankings/date/:date` | Conditional | Any | Date-specific rankings (YYYY-MM-DD) |

**Ranking Response Format:**
```json
[
  {
    "player_id": 1,
    "player_name": "Nguyen Van A",
    "total_matches": 50,
    "wins": 35,
    "losses": 15,
    "win_rate": 0.70,
    "ranking_points": 140,
    "form": ["W", "W", "L", "W", "W"]
  }
]
```

### Export Endpoints (Excel)

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| GET | `/api/export-excel` | Yes | Editor | Full export (all data, streamed) |
| GET | `/api/export-excel/date/:date` | Yes | Editor | Export by date |
| GET | `/api/export-excel/season/:seasonId` | Yes | Editor | Export by season |
| GET | `/api/export-excel/lifetime` | Yes | Editor | Lifetime rankings only |

### Backup Endpoints

| Method | Path | Auth | Role | Rate Limiter | Description |
|--------|------|------|------|-------------|-------------|
| GET | `/api/backup` | Yes | Admin | `criticalLimiter` | Full backup (with users) |
| GET | `/api/backup-data` | Yes | Admin | `exportLimiter` | Data-only backup (no users) |
| POST | `/api/restore` | Yes | Admin | `restoreLimiter` | Restore from backup JSON |

**Backup Response Format:**
```json
{
  "version": "2.2",
  "timestamp": "2025-01-15T10:00:00.000Z",
  "exportedBy": "admin",
  "players": [...],
  "seasons": [{ ..., "players": [1, 2, 3] }],
  "matches": [...],
  "users": [...]
}
```

### Health Endpoints

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| GET | `/health` | No | — | Public health check (for load balancers) |
| GET | `/api/health` | Yes | Admin | Full health (DB + cache status) |
| GET | `/api/performance` | Yes | Admin | Memory/CPU metrics |
| GET | `/api/cache-stats` | Yes | Admin | Redis cache statistics |

### Admin Endpoints

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| GET | `/api/admin/access-stats` | Yes | Admin | Access log statistics |
| GET | `/api/admin/access-logs` | Yes | Admin | Access logs |
| GET | `/api/admin/ip-analysis` | Yes | Admin | IP analysis |
| GET | `/api/admin/active-sessions` | Yes | Admin | Active sessions |
| GET | `/api/admin/security-dashboard` | Yes | Admin | Security dashboard |
| GET | `/api/admin/fcm/status` | Yes | Admin | FCM push status |

### Auth User Management Endpoints

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| GET | `/api/auth/users` | Yes | Admin | List all users |
| GET | `/api/auth/users/:id` | Yes | Admin | Get single user |
| POST | `/api/auth/users` | Yes | Admin | Create user |
| PUT | `/api/auth/users/:id` | Yes | Admin | Update user |
| DELETE | `/api/auth/users/:id` | Yes | Admin | Delete user |
| PUT | `/api/auth/users/:id/password` | Yes | Admin | Reset password |

**Create User Request:**
```json
{
  "username": "john_doe",
  "password": "securePassword123!",
  "email": "john@example.com",
  "role": "editor",
  "displayName": "John Doe",
  "notes": "Tournament organizer",
  "receiveMatchNotifications": true,
  "receiveSeasonNotifications": false
}
```

### Device Endpoints (FCM)

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| POST | `/api/devices/register` | Conditional | Any | Register FCM device token |

**Register Device Request:**
```json
{
  "token": "fcm-registration-token-here",
  "platform": "android",
  "appVersion": "1.0.0"
}
```

---

## Cache System

### Three-Tier Architecture

| Tier | Location | TTL | Invalidation |
|------|----------|-----|-------------|
| 1. PostgreSQL | Primary storage | Permanent | Direct mutations |
| 2. Redis | Distributed cache | 24 hours | PG triggers + explicit calls |
| 3. Client | Browser Map | Type-specific (see below) | SSE version polling |

### Redis Cache Keys

| Key Pattern | Content | TTL |
|-------------|---------|-----|
| `tennis:rankings:lifetime` | Lifetime player rankings with forms | 24h |
| `tennis:rankings:season:{id}` | Season-specific rankings | 24h |
| `tennis:rankings:date:{YYYY-MM-DD}` | Date-specific rankings | 24h |
| `tennis:players` | All players list | 24h |
| `tennis:seasons` | All seasons list | 24h |
| `tennis:season:active` | Currently active season | 24h |
| `tennis:seasons:active` | Active seasons list | 24h |
| `tennis:matches:date:{YYYY-MM-DD}` | Matches for specific date | 24h |
| `tennis:playdates` | List of all play dates | 24h |
| `tennis:playdate:latest` | Latest play date | 24h |
| `tennis:version` | Data version timestamp | Permanent |

### Client-Side Cache TTLs

| Type | TTL | Rationale |
|------|-----|-----------|
| Rankings | 2 minutes | Changes with new matches |
| Matches | 1 minute | Frequently updated |
| Players | 10 minutes | Rarely changes |
| Seasons | 10 minutes | Rarely changes |
| Play Dates | 5 minutes | Changes with new matches |
| Version Check | 30 seconds | Poll interval for server sync |

### Cache Invalidation Methods

```javascript
// After player mutations
await rankingsCache.invalidateOnPlayerChange()

// After match mutations (requires play_date)
await rankingsCache.invalidateOnMatchChange(playDate)

// After season mutations
await rankingsCache.invalidateOnSeasonChange()

// Full cache clear (DEV only)
await rankingsCache.clear()
```

---

## Authentication & Security

### Two-Tier Role System

| Role | Permissions |
|------|------------|
| **Admin** | Full CRUD on players, seasons, matches, users. Can backup/restore. |
| **Editor** | Can edit/create/delete matches. Can add/remove players from seasons. Cannot create/delete seasons or players. |
| **Viewer** | Read-only access (no write endpoints). |

### JWT Token Flow

1. **Login** → Server returns encrypted `authToken` (access, 15min) and `refreshToken` (7 days) as httpOnly cookies
2. **Access token** → AES-256-GCM encrypted, stored in cookie, verified on each request
3. **Refresh** → POST `/api/auth/refresh` with refresh token cookie → new access token issued
4. **Logout** → Increments `token_version`, clears all cookies, sends `Clear-Site-Data` header

### Security Features

| Feature | Implementation |
|---------|---------------|
| JWT Encryption | AES-256-GCM with scrypt key derivation, random IV per token |
| CSRF Protection | HMAC-SHA256(secret, sessionId) double-submit via `X-CSRF-Token` header |
| Password Hashing | bcrypt with 14 rounds (configurable) |
| Rate Limiting | Redis-backed with dynamic scaling based on CPU/RAM usage |
| Helmet | Strict CSP, HSTS, Permissions-Policy, frameguard deny, XSS filter |
| CORS | Origin whitelist + local network regex in dev |
| Timing-Safe Compare | `crypto.timingSafeEqual` for secret comparison |
| Token Revocation | Server-side `token_version` bump on logout/user update |

### Cookie Configuration

| Cookie | Max-Age | HttpOnly | Secure | SameSite |
|--------|---------|----------|--------|----------|
| `authToken` | 15 min | Yes | Production only | strict/lax |
| `refreshToken` | 7 days | Yes | Production only | strict/lax |
| `csrfSessionId` | Session | Yes | Production only | strict/lax |

---

## Frontend Architecture

### SPA Structure (`src/main.js`)

- **~4000 lines** of vanilla JavaScript (no framework)
- Client-side routing with smart caching
- Vietnamese UI labels, English code/comments
- SSE listener for real-time updates

### Smart Client Cache

```javascript
// Cache structure
this.cache = {
  rankings: new Map(),   // Key: 'daily:date' | 'season:id' | 'lifetime'
  matches: new Map(),    // Key: 'all' | 'date:date' | 'season:id'
  players: null,         // Single value (all players)
  seasons: null,         // Single value (all seasons)
  playDates: null,
  lastFetch: new Map(),  // Timestamps for TTL checking
  serverVersion: null    // For cache coherence
}
```

### Cache Coherence

1. Client polls `/api/data-version` every 30 seconds via SSE
2. On version mismatch → full client cache clear
3. After successful mutation → selective invalidation of affected types only

---

## Deployment

### Docker Compose (Recommended)

```bash
docker compose up -d
```

Services:
- **tennis-postgres** (PostgreSQL 15, :5432)
- **tennis-redis** (Redis 7, :6380→6379)
- **tennis-app** (Express + Vite build, PM2 cluster, :3001)
- **tennis-worker** (FCM push sender worker)

### PM2 Cluster

```bash
npm run build && pm2 start ecosystem.config.cjs --env production
```

Requires external PostgreSQL and Redis.

### Bare Node

```bash
NODE_ENV=production node server.js
```

Single process, no clustering.

### Dev Mode

```bash
docker compose up -d postgres redis
npm run dev-full    # Vite HMR (:5173) + Express (:3001)
```

---

## Configuration

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `ADMIN_USERNAME` | Admin username | `admin` |
| `ADMIN_PASSWORD` | Admin password (hashed at startup) | `secret` |
| `EDITOR_USERNAME` | Editor username | `editor` |
| `EDITOR_PASSWORD` | Editor password (hashed at startup) | `secret` |
| `JWT_SECRET` | JWT signing secret (32+ chars) | crypto random hex |
| `CSRF_SECRET` | CSRF HMAC secret (32+ chars) | crypto random hex |

### Database Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `DB_NAME` | PostgreSQL database name | Required |
| `DB_USER` | PostgreSQL user | Required |
| `DB_PASSWORD` | PostgreSQL password | Required |
| `DB_HOST` | PostgreSQL host | `localhost` |
| `DB_PORT` | PostgreSQL port | `5432` |
| `DB_SSL` | Enable SSL | `false` |
| `DB_SSL_REJECT_UNAUTHORIZED` | Reject untrusted certs | `true` |
| `DB_SSL_CA` | Custom CA certificate path | — |
| `DB_POOL_MAX` | Max pool connections | `20` |

### Redis Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `CACHE_TTL_SECONDS` | Cache TTL in seconds | `86400` (24h) |
| `CACHE_PRELOAD_INTERVAL` | Preload interval ms | `240000` (4 min) |

### Server Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Express server port | `3001` |
| `NODE_ENV` | Environment | `development` |
| `SUBPATH` / `BASE_PATH` | URL subpath for deployment | `/tennis` (prod), `/` (dev) |
| `TRUST_PROXY` | Enable trust proxy | auto-detected |
| `MAX_SSE_CLIENTS` | Max SSE connections | `1000` |
| `REQUEST_TIMEOUT_MS` | Request timeout ms | `30000` |

### Rate Limiting

| Variable | Description | Default |
|----------|-------------|---------|
| `RATE_LIMIT_WINDOW_MS` | Window duration ms | `900000` (15 min) |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per window | `1000` |
| `RATE_LIMIT_API_MAX` | API endpoint max | `100` |
| `DISABLE_RATE_LIMITING` | Disable all rate limiting | `false` |
| `RATE_LIMIT_DYNAMIC_ENABLED` | Enable CPU/RAM-based scaling | `false` |

### Security

| Variable | Description | Default |
|----------|-------------|---------|
| `BCRYPT_ROUNDS` | bcrypt work factor | `14` |
| `JWT_ACCESS_TOKEN_EXPIRY` | Access token lifetime | `15m` |
| `JWT_REFRESH_TOKEN_EXPIRY` | Refresh token lifetime | `7d` |
| `COOKIE_SECURE` | Secure cookie flag | auto (production) |
| `COOKIE_SAMESITE` | SameSite policy | `strict` (prod), `lax` (dev) |
| `COOKIE_DOMAIN` | Cookie domain | — |

### CORS

| Variable | Description | Default |
|----------|-------------|---------|
| `ALLOWED_ORIGINS` | Comma-separated allowed origins | `[]` |
| `PUBLIC_DOMAIN` | Public domain (auto-added to CORS) | — |

### FCM / Push Notifications

| Variable | Description | Default |
|----------|-------------|---------|
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Path to Firebase JSON key | — |
| `FCM_TOKEN_RETENTION_DAYS` | Stale token retention days | `30` |
| `FCM_MAX_DEVICES_PER_USER` | Max devices per user | `10` |
| `FCM_MAX_GUEST_DEVICES_PER_IP` | Max guest devices per IP | `5` |

---

## Migration Scripts

| Script | Purpose |
|--------|---------|
| `apply-multi-season-migration.sh` | Add multi-season support |
| `apply-multi-season-update.sh` | Multi-season data migration |
| `apply-season-players-migration.sh` | Add season_players junction table |
| `apply-performance-indexes.sh` | Add performance indexes |
| `apply-cache-triggers-migration.sh` | Add Redis cache invalidation triggers |

All migrations are idempotent and tracked via flag environment variables.

---

## File Organization

| Directory | Contents |
|-----------|----------|
| `config/` | Environment config, cookie defaults, CORS settings |
| `lib/` | Redis cache, JWT encryption, security helpers, FCM push sender |
| `middleware/` | Auth middleware, CSRF protection, compression, rate limiting |
| `routes/` | Modular Express routers (players, matches, seasons, rankings, export, auth, devices, admin, backup, health, system) |
| `utils/` | Async handler wrapper, Excel helper, stream helper |
| `migrations/` | SQL migration files and shell scripts |
| `data/postgres-init/` | PostgreSQL init scripts (entrypoint) |
| `src/` | Frontend SPA (main.js, style.css) |
| `tests/unit/` | Unit tests (config, CSRF, JWT encryption) |
