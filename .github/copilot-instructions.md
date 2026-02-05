# Tennis Doubles Ranking System - AI Agent Instructions

## System Architecture

**Stack**: Express.js backend (ESM), PostgreSQL + Redis cache, Vite frontend (vanilla JS)  
**Data Flow**: Client → Express API → PostgreSQL (primary) → Redis cache (with auto-invalidation) → Client cache

### Key Components

- **[server.js](../server.js)**: Main Express app with dependency injection pattern for routers
- **[database-postgresql.js](../database-postgresql.js)**: PostgreSQL adapter (1200+ lines) with all DB operations
- **[lib/redis-cache.js](../lib/redis-cache.js)**: Redis caching layer with PostgreSQL LISTEN/NOTIFY integration
- **[routes/*.js](../routes)**: Modular routers created via factory functions (`createPlayerRouter`, etc.)
- **[src/main.js](../src/main.js)**: Frontend SPA (4000+ lines) with smart client-side caching

### Multi-Layer Caching Strategy

1. **Client cache** ([src/main.js](../src/main.js)): Type-specific TTLs (rankings: 2m, matches: 1m, players: 10m)
   - Polls `/data-version` every 30s for server-side change detection
   - Invalidates on version mismatch for cache coherence
2. **Redis cache** ([lib/redis-cache.js](../lib/redis-cache.js)): 24hr TTL, preloads common data on startup
   - Auto-invalidates via PostgreSQL triggers (see [migrations/add-cache-notify-triggers.sql](../migrations/add-cache-notify-triggers.sql))
   - Listens to `tennis_cache_invalidation` channel for real-time updates
3. **PostgreSQL**: Source of truth with performance indexes

## Critical Patterns

### Router Factory Injection

All routes use dependency injection - never import `db` or middleware directly:

```javascript
// ❌ WRONG - Don't do this
import db from '../database.js'
router.get('/players', async (req, res) => { ... })

// ✅ CORRECT - Use factory pattern
export const createPlayerRouter = ({ db, checkAuth, rankingsCache, ... }) => {
  const router = Router()
  router.get('/', checkAuth, asyncHandler(async (req, res) => {
    const players = await db.getPlayers()
    res.json(sanitizeResponse(players))
  }))
  return router
}
```

Dependencies are wired in [server.js](../server.js#L2800-L2900) after initialization.

### Cache Invalidation

**ALWAYS** call cache invalidation after mutations:

```javascript
// After player changes
await rankingsCache.invalidateOnPlayerChange()

// After match changes
await rankingsCache.invalidateOnMatchChange(playDate)

// After season changes
await rankingsCache.invalidateOnSeasonChange()
```

PostgreSQL triggers ([migrations/add-cache-notify-triggers.sql](../migrations/add-cache-notify-triggers.sql)) auto-invalidate Redis on DB changes.

### Error Handling & Security

- **Wrap all async routes** with `asyncHandler` from [utils/async-handler.js](../utils/async-handler.js)
- **Use `sendError()` and `sendSuccess()`** for consistent API responses with error codes
- **Sanitize responses**: Always call `sanitizeResponse()` to convert Unix timestamps to ISO strings (prevents timestamp disclosure attacks)
- **Input validation**: Use `express-validator` with HTML escaping (`body('name').trim().escape()`)
- **CSRF protection**: All mutating endpoints require CSRF token (checked in [middleware/auth.js](../middleware/auth.js))

### Authentication System

Two-tier role system:
- **Admin** (`authenticateToken` + `requireAdmin`): Full CRUD access
- **Editor** (`authenticateToken` + `requireEditor`): Can only edit matches, not create/delete

JWT tokens are encrypted in cookies using AES-256-GCM (see [lib/security-helpers.js](../lib/security-helpers.js#L45-L80)).

## Security Details

### JWT Token Encryption (AES-256-GCM)

JWT tokens are **never stored in plain text** in cookies. They are encrypted using AES-256-CBC with scrypt key derivation:

```javascript
// In lib/security-helpers.js
const encryptJWT = (token) => {
  const algorithm = 'aes-256-cbc'
  const key = crypto.scryptSync(jwtSecret, 'jwt-salt', 32)  // Key derivation
  const iv = crypto.randomBytes(16)                         // Random IV per encryption
  const cipher = crypto.createCipheriv(algorithm, key, iv)
  // ... returns iv:encrypted format
}
```

**Key points:**
- Key derived from `JWT_SECRET` using `scrypt` (memory-hard, resistant to GPU attacks)
- Unique random IV for each token (prevents pattern analysis)
- Token format: `{iv_hex}:{encrypted_hex}`

### Timing-Safe Comparisons

**ALWAYS** use timing-safe comparison for secrets to prevent timing attacks:

```javascript
import { timingSafeCompare } from '../lib/security-helpers.js'

// ❌ WRONG - vulnerable to timing attack
if (userToken === expectedToken) { ... }

// ✅ CORRECT - constant-time comparison
if (timingSafeCompare(userToken, expectedToken)) { ... }
```

The `timingSafeCompare` function uses `crypto.timingSafeEqual` with length normalization.

### CSRF Protection Flow

1. **Session ID** stored in `csrfSessionId` httpOnly cookie (not the secret itself)
2. **CSRF secret** derived via HMAC: `HMAC-SHA256(CSRF_SECRET, sessionId)`
3. **Token** generated from secret using `csrf` library
4. **Validation**: All non-GET requests must include `X-CSRF-Token` header

```javascript
// Secret derivation (never stored in cleartext)
const deriveCSRFSecret = (sessionId) => {
  return crypto.createHmac('sha256', CSRF_SECRET)
    .update(sessionId)
    .digest('base64')
}
```

## Frontend Caching Strategy

### Client-Side Cache Architecture

The frontend ([src/main.js](../src/main.js)) implements a **multi-tier smart cache** with type-specific TTLs:

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

// Type-specific TTLs
this.CACHE_TTL = {
  rankings: 2 * 60 * 1000,      // 2 min - changes with new matches
  matches: 1 * 60 * 1000,       // 1 min - frequently updated
  players: 10 * 60 * 1000,      // 10 min - rarely changes
  seasons: 10 * 60 * 1000,      // 10 min - rarely changes
  playDates: 5 * 60 * 1000,     // 5 min - changes with new matches
  versionCheck: 30 * 1000       // 30 sec - server version poll
}
```

### Cache Coherence via Version Polling

Clients poll `/api/data-version` every 30 seconds to detect server-side changes:

```javascript
async checkServerVersion() {
  const response = await fetch(`${this.apiBase}/data-version`)
  const { version } = await response.json()
  
  // If version changed, invalidate ALL client cache
  if (this.cache.serverVersion !== null && this.cache.serverVersion !== version) {
    console.log('🔄 Server data changed, clearing cache')
    this.invalidateCache()  // Full clear
  }
  this.cache.serverVersion = version
}
```

### Selective Cache Invalidation

When making mutations, invalidate only affected cache types:

```javascript
// After recording a match
this.invalidateCache(['rankings', 'matches', 'playDates'])

// After adding a player
this.invalidateCache(['players'])

// After data restore (full clear)
this.invalidateCache()  // No args = clear everything
```

## Database SQL Patterns

### Window Functions for Rankings

Use `ROW_NUMBER()` for batch form queries (avoids N+1):

```sql
-- Get last N matches per player in single query
WITH player_matches AS (
  SELECT 
    p.id as player_id,
    CASE WHEN (m.winning_team = 1 AND (m.player1_id = p.id OR m.player2_id = p.id)) 
         OR (m.winning_team = 2 AND (m.player3_id = p.id OR m.player4_id = p.id))
    THEN 'win' ELSE 'loss' END as result,
    ROW_NUMBER() OVER (
      PARTITION BY p.id 
      ORDER BY m.play_date DESC, m.created_at DESC
    ) as rn
  FROM unnest($1::int[]) AS p(id)
  INNER JOIN matches m ON m.player1_id = p.id OR m.player2_id = p.id ...
)
SELECT * FROM player_matches WHERE rn <= $2
```

### UPSERT Pattern (ON CONFLICT)

Use `ON CONFLICT DO NOTHING` for idempotent inserts:

```javascript
// In database-postgresql.js
await client.query(`
  INSERT INTO season_players (season_id, player_id, added_by)
  VALUES ($1, $2, $3)
  ON CONFLICT (season_id, player_id) DO NOTHING
`, [seasonId, playerId, addedBy])
```

### Transaction Pattern

**ALWAYS** use transactions for multi-step mutations:

```javascript
const client = await this.pool.connect()
try {
  await client.query('BEGIN')
  
  // Multiple operations...
  await client.query('INSERT INTO ...', [...])
  await client.query('UPDATE ...', [...])
  
  await client.query('COMMIT')
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  client.release()  // ALWAYS release back to pool
}
```

### Parameterized Array Queries

Pass arrays using PostgreSQL's `unnest()`:

```javascript
// ❌ WRONG - SQL injection risk
const ids = playerIds.join(',')
await db.query(`SELECT * FROM players WHERE id IN (${ids})`)

// ✅ CORRECT - parameterized
await db.query(`
  SELECT * FROM players WHERE id = ANY($1::int[])
`, [playerIds])
```

## Development Workflow

### Setup & Running

```bash
# Start PostgreSQL + Redis (Docker)
docker-compose up -d

# Install & run dev server
npm install
npm run dev          # Vite frontend only
npm run server       # Backend only  
npm run dev-full     # Both (uses concurrently)
```

### Migrations

Apply in order (tracked in `.env` flags):
1. Multi-season: `./apply-multi-season-migration.sh`
2. Performance indexes: `./apply-performance-indexes.sh`
3. Cache triggers: `./apply-cache-triggers-migration.sh`

Check PostgreSQL logs: `docker logs tennis-postgres`

### Environment Variables

See [.env](../.env) for all options. Key settings:
- `DB_*`: PostgreSQL connection (required)
- `REDIS_URL`: Cache connection (defaults to localhost:6379)
- `COOKIE_SECURE`: Set to `'false'` for local HTTP dev (defaults to `true` in production)
- `TRUST_PROXY`: Enable for Nginx/Cloudflare (`'true'`)
- `CACHE_TTL_SECONDS`: Redis TTL (default: 86400 = 24h)

## Common Tasks

### Adding a New API Endpoint

1. Create route in [routes/*.js](../routes) using factory pattern with dependency injection
2. Add `asyncHandler()` wrapper for error handling
3. Add validation with `express-validator`
4. Call appropriate cache invalidation (`rankingsCache.invalidateOn*`)
5. Wire router in [server.js](../server.js) with all dependencies

### Modifying Database Schema

1. Create migration SQL in [migrations/](../migrations)
2. Update [database-postgresql.js](../database-postgresql.js) method
3. Create shell script (e.g., `apply-*.sh`) to apply migration
4. Test on local Docker PostgreSQL first

### Debugging Cache Issues

- Check Redis connection: `docker exec tennis-redis redis-cli PING`
- View cache stats: Check server logs for `📊 Cache Stats` (logged every 4 minutes)
- Manual invalidation: `await rankingsCache.clear()` (DEV only)
- Verify triggers: Query `pg_trigger` in PostgreSQL for `tennis_cache_notify_*`

## File Naming & Organization

- `database-*.js`: Database adapters (PostgreSQL, SQLite legacy, factory)
- `routes/*.js`: Modular Express routers (players, matches, seasons, rankings, export, users)
- `middleware/*.js`: Auth middleware (currently only [auth.js](../middleware/auth.js))
- `utils/*.js`: Shared utilities ([async-handler.js](../utils/async-handler.js), [excel-helper.js](../utils/excel-helper.js))
- `lib/*.js`: Core libraries (redis-cache, security-helpers)
- Shell scripts: Deployment and migration helpers (`.sh` files in root)

## Gotchas

- **ESM only**: Use `import/export`, not `require()`. Node.js 18+ required.
- **Cookie paths**: Always clear cookies on all paths using `clearCookieAllPaths()` due to historical path variations
- **Rate limiting**: Conditionally applied - skips for authenticated users with `conditionalRateLimit()`
- **CSRF token**: Must be obtained from `/api/auth/csrf-token` before mutations
- **Vietnamese UI**: Frontend uses Vietnamese labels, but code/comments are English
- **Match types**: System supports both doubles (`duo`) and singles (`solo`) matches
- **Season isolation**: Players/matches are scoped to seasons (see `season_players` junction table)
