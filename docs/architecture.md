# Tennis Ranking System — Architecture

## System Overview

```mermaid
graph TB
    subgraph "Client"
        Browser["Browser (Vite SPA)"]
    end

    subgraph "Server (Node.js / Express)"
        direction TB
        MW["Middleware Stack<br/>Helmet · CORS · CSRF · Compression · Auth"]
        Routes["API Routes<br/>players · seasons · matches · rankings<br/>export · auth · admin · backup · system"]
        SSE["SSE Push<br/>(real-time updates)"]
    end

    subgraph "Data Layer"
        PG["PostgreSQL<br/>Players · Seasons · Matches"]
        Redis["Redis<br/>Cache · Rate Limiting"]
    end

    Browser -->|"HTTP/JSON"| MW
    MW --> Routes
    Routes --> PG
    Routes --> Redis
    SSE -->|"EventSource"| Browser
    PG -->|"LISTEN/NOTIFY"| Redis
```

## Directory Structure

```
ranking/
├── config/                  # Environment & cookie config
│   ├── env.js               # Validates env vars, exports typed config
│   └── cookie.js            # Cookie defaults, path-clearing helpers
├── lib/                     # Core libraries
│   ├── jwt-encryption.js    # AES-256-GCM JWT encrypt/decrypt
│   ├── redis-cache.js       # Redis caching with stampede protection
│   └── security-helpers.js  # CSRF derivation, timing-safe compare
├── middleware/              # Express middleware
│   ├── auth.js              # authenticateToken, checkAuth, requireRole
│   ├── compression.js       # Brotli + gzip compression
│   ├── csrf.js              # Global CSRF protection
│   └── rate-limiter.js      # Dynamic rate limiting (Redis-backed)
├── routes/                  # API route modules
│   ├── admin.js             # Admin analytics
│   ├── backup.js            # Backup/restore
│   ├── export.js            # Excel export
│   ├── health.js            # Health checks (public + authenticated)
│   ├── matches.js           # Match CRUD
│   ├── players.js           # Player CRUD
│   ├── rankings.js          # Ranking queries
│   ├── seasons.js           # Season management
│   ├── system.js            # SSE, CSRF tokens, init, debug
│   └── users.js             # User account management
├── migrations/              # SQL migrations
├── tests/                   # Test suite (Vitest)
│   └── unit/                # Unit tests
├── src/                     # Frontend (Vite)
│   ├── main.js              # SPA entry point
│   └── style.css            # Design system
├── server.js                # Express app bootstrap (~340 lines)
├── database-postgresql.js   # Database schema + queries
├── ecosystem.config.cjs     # PM2 cluster configuration
├── Dockerfile               # Multi-stage Docker build
├── docker-compose.yml       # Full-stack Docker deployment
└── docker-compose.override.yml  # Dev overrides (expose PG/Redis ports)
```

## Deployment Modes

### 1. Docker (Recommended for Production)

```bash
# Full containerized stack (app + PostgreSQL + Redis)
docker compose up -d

# View logs
docker compose logs -f app
```

The app container runs PM2 inside Docker using `dumb-init` for proper PID 1 signal handling.

### 2. PM2 Bare Metal

```bash
# Prerequisites: PostgreSQL and Redis running on host
npm run build
pm2 start ecosystem.config.cjs --env production
pm2 save && pm2 startup
```

### 3. Direct Node.js

```bash
# Prerequisites: PostgreSQL and Redis running on host
npm run build
NODE_ENV=production node server.js
```

### 4. Development (Hybrid)

```bash
# Start PostgreSQL + Redis in Docker, app on host
docker compose up -d postgres redis
npm run dev-full    # starts Vite + Express concurrently
```

## Authentication Flow

```mermaid
sequenceDiagram
    participant C as Browser
    participant S as Server
    participant DB as PostgreSQL

    C->>S: POST /api/auth/login (username, password)
    S->>DB: getUserByUsername()
    DB-->>S: user record (with bcrypt hash)
    S->>S: bcrypt.compare(password, hash)
    S->>S: Generate JWT (HS256)
    S->>S: Encrypt JWT (AES-256-GCM)
    S-->>C: Set httpOnly cookies (authToken, refreshToken, csrfSessionId)
    Note over C,S: All subsequent requests include cookies automatically

    C->>S: GET /api/rankings (with cookie)
    S->>S: Decrypt cookie → verify JWT → req.user
    S-->>C: Rankings data
```

## Cache Strategy

```mermaid
graph LR
    subgraph "Cache Flow"
        A[API Request] --> B{Redis Cache?}
        B -->|HIT| C[Return Cached]
        B -->|MISS| D[Acquire Lock]
        D -->|Got Lock| E[Query PostgreSQL]
        E --> F[Store in Redis]
        F --> C
        D -->|Lock Held| G[Wait & Retry]
        G -->|Eventually HIT| C
        G -->|Exhausted| E
    end

    subgraph "Invalidation"
        H[Data Mutation] --> I[PostgreSQL Trigger]
        I -->|NOTIFY| J[Redis Cache]
        J -->|Delete Keys| K[SSE Push]
        K -->|version change| L[All Browsers]
    end
```

Key design decisions:
- **Startup cache**: Rankings, players, seasons are pre-loaded at boot (permanent, no TTL)
- **Stampede protection**: Distributed locks prevent multiple workers from rebuilding the same cache key
- **Auto-invalidation**: PostgreSQL triggers fire `NOTIFY cache_invalidation` on every INSERT/UPDATE/DELETE
- **Real-time sync**: SSE pushes version changes to all connected clients immediately

## Rate Limiting

- **Redis-backed**: Works across PM2 cluster workers
- **Dynamic scaling**: Limits reduce automatically when CPU > 80% or RAM > 85%
- **User-aware**: Authenticated users get 2–4x higher limits than anonymous users
- **Graceful degradation**: If Redis is down, rate limiting is bypassed (passOnStoreError)

## Security Layers

| Layer | Implementation |
|-------|---------------|
| Transport | HSTS (2 years), upgrade-insecure-requests |
| Headers | Helmet (CSP, X-Frame-Options, Permissions-Policy) |
| Authentication | JWT in AES-256-GCM encrypted httpOnly cookies |
| CSRF | HMAC-derived secrets + double-submit token pattern |
| Passwords | bcrypt with 14 rounds |
| Rate Limiting | Redis-backed, dynamic, user-aware |
| Input | express-validator on all endpoints |
| XSS | CSP, X-XSS-Protection, sanitizeResponse() |
