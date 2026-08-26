# Tennis Ranking System — Mobile App Handoff

**Project:** `/home/vps/tennisranking`  
**Prepared for:** Mobile app team  
**Date:** 2026-05-23  
**Purpose:** Document the current web application, its API surface, authentication model, data model, security rules, and mobile integration requirements so a mobile app can reuse the same backend and match the web app’s behavior.

---

## 1) Executive summary

This application is a tennis ranking and match-tracking system built as:

- **Frontend:** React 19 + TypeScript SPA built with Vite
- **Backend:** TypeScript + Node.js + Express
- **Database:** PostgreSQL
- **Cache / messaging:** Redis + PostgreSQL NOTIFY/LISTEN + SSE
- **Authentication:** JWT access/refresh tokens, stored in encrypted cookies, with optional bearer-token support for API clients
- **Security:** Helmet, CSRF protection, bcrypt passwords, rate limiting, role-based access control

The web app supports:

- player management
- season management
- match creation/editing/deletion
- lifetime / season / daily rankings
- Excel export
- JSON backup/restore
- admin analytics
- real-time cache updates via SSE

For a mobile app, the backend is already usable as an API. The main caveat is that **write requests require CSRF protection**, and the current CSRF scheme depends on a persistent `csrfSessionId` cookie. So a mobile client should keep a **cookie jar** even if it also uses bearer tokens.

---

## 2) System overview

### 2.1 Architecture

The app is split into three major layers:

1. **Client SPA**
   - Loads initial bootstrap data from `/api/init`
   - Uses `/api/events` SSE or `/api/data-version` polling to stay in sync
   - Calls REST endpoints for players, seasons, matches, rankings, export, auth, etc.

2. **Express API server**
   - Handles authentication, validation, CSRF, rate limiting, and route logic
   - Serves static SPA files in production
   - Mounts route modules for each domain

3. **PostgreSQL + Redis**
   - PostgreSQL stores source-of-truth data
   - Redis caches common reads and stores the shared data version
   - PostgreSQL triggers emit `NOTIFY cache_invalidation` events so Redis can invalidate keys selectively

### 2.2 Deployment note

The app may be deployed under a subpath, not only the root.

- Development root API: `http://localhost:3001/api`
- Production may use a subpath such as: `https://yourdomain.com/tennis/api`

The frontend auto-detects this, but a mobile app should make the base URL configurable.

---

## 3) Authentication and authorization

### 3.1 User types

The system supports two kinds of authenticated users:

1. **Database users**
   - Stored in PostgreSQL `users` table
   - Password hashes stored in DB
   - Support token revocation using `token_version`

2. **System users**
   - Configured via environment variables:
     - `ADMIN_USERNAME`, `ADMIN_PASSWORD`
     - `EDITOR_USERNAME`, `EDITOR_PASSWORD`
   - Useful for bootstrap and emergency access
   - These users do not rely on DB lookup for login

### 3.2 Roles

The code recognizes at least these roles:

- `admin`
- `editor`
- `viewer`

Permission model:

- **admin**: full access, including users, backup/restore, admin analytics, delete operations
- **editor**: can manage matches, seasons, exports, and some season player operations
- **viewer**: read-only / limited access depending on endpoint

### 3.3 Login flow

`POST /api/auth/login`:

- checks DB user first
- falls back to env-based system users
- compares password with bcrypt
- generates:
  - short-lived access token
  - refresh token
- encrypts tokens before storing in cookies
- returns a CSRF token
- if request looks like an API client (`Accept: application/json`), also returns a bearer token in the JSON body

### 3.4 Token storage

Cookies used by the server:

- `authToken`
  - encrypted JWT access token
  - max age: 15 minutes
- `refreshToken`
  - encrypted JWT refresh token
  - max age: 7 days
- `csrfSessionId`
  - random session identifier used to derive CSRF secret
  - max age: 24 hours

Cookies are created with security defaults from config:

- `httpOnly: true`
- `secure` depends on environment / `COOKIE_SECURE`
- `sameSite` defaults to `strict` in production, `lax` in development

### 3.5 Bearer token support

The auth middleware accepts:

- `authToken` cookie
- or `Authorization: Bearer <token>` header

This means a mobile app can use bearer auth for access-token-protected reads and writes.

**Important:** CSRF still depends on the cookie-backed `csrfSessionId`. So even with bearer auth, the mobile app should preserve cookies.

### 3.6 CSRF

All state-changing requests are protected by a global CSRF middleware.

CSRF token sources:

- login response
- `/api/csrf-token`
- `/api/auth/status`
- `/api/init`

Header for mutating requests:

- `X-CSRF-Token: <token>`

If CSRF validation fails, the server responds:

```json
{ "error": "Invalid CSRF token", "csrfRequired": true }
```

### 3.7 Token revocation

The backend supports revocation through `token_version`:

- changing a password increments token version
- disabling or editing a user may bump token version
- logout increments token version for DB users
- middleware rejects JWTs with an outdated token version

### 3.8 Refresh behavior

`POST /api/auth/refresh` currently reads the refresh token from the **cookie**, not from a bearer header.

That means mobile clients have two workable choices:

1. **Recommended:** preserve cookies in the HTTP client, then call refresh normally
2. If not preserving cookies, re-login when access expires

At the moment, there is no separate mobile refresh-token endpoint that accepts a JSON body or bearer refresh token.

---

## 4) API conventions for the mobile team

### 4.1 Base URL

The mobile app should configure the API base URL, for example:

- Development: `http://localhost:3001/api`
- Production root: `https://domain.com/api`
- Production subpath: `https://domain.com/tennis/api`

### 4.2 Request headers

Typical headers:

```http
Accept: application/json
Content-Type: application/json
Authorization: Bearer <access-token>
X-CSRF-Token: <csrf-token>
```

For cookie-based auth, include cookie persistence as well.

### 4.3 Data formats

- Dates are generally `YYYY-MM-DD`
- Timestamps are ISO-8601 strings
- IDs are numeric
- Match types:
  - `duo`
  - `solo`

### 4.4 Read caching

Many `GET` endpoints return a `Redis-Cache` header of `HIT` or `MISS`.

The mobile app does not need to depend on that header, but it can use it for diagnostics.

### 4.5 Real-time updates

The frontend uses SSE at `/api/events` to receive a data-version update.

Mobile options:

- use SSE if your framework supports it well
- or poll `/api/data-version`
- or refresh key screens after successful mutations

---

## 5) API reference

## 5.1 Public / system endpoints

### `GET /health`
Public liveness check.

Response:

```json
{
  "status": "healthy",
  "timestamp": "...",
  "uptime": 12345,
  "checks": {
    "cache": { "status": "healthy" }
  }
}
```

### `GET /api/data-version`
Returns the current server-side cache version.

Auth: optional / session-aware

Response:

```json
{ "version": 1716451234567 }
```

### `GET /api/csrf-token`
### `POST /api/csrf-token`
Creates or reuses the CSRF session cookie and returns a token.

Response:

```json
{ "csrfToken": "..." }
```

### `GET /api/init`
Bootstrap endpoint used by the SPA.

Auth: optional / session-aware

Returns all initial app data in one call:

- lifetime rankings
- players
- seasons
- active seasons
- play dates
- active season
- default date rankings
- default date matches
- user session state
- CSRF token
- data version

Response shape:

```json
{
  "lifetimeRankings": [],
  "players": [],
  "seasons": [],
  "activeSeasons": [],
  "playDates": [],
  "activeSeason": null,
  "defaultDate": "YYYY-MM-DD",
  "defaultDateRankings": [],
  "defaultDateMatches": [],
  "version": 1716451234567,
  "isAuthenticated": false,
  "user": null,
  "timestamp": "...",
  "csrfToken": "..."
}
```

### `GET /api/events`
Server-Sent Events stream for live invalidation.

Auth: required

Initial event includes current version:

```json
{ "type": "version", "version": 1716451234567 }
```

Then version-change events are sent whenever data changes.

### `POST /api/csp-report`
Receives CSP violation reports.

No auth required.

### `GET /api/debug/config`
Debug endpoint for admin use.

Auth: admin only

Returns proxy, routing, and request metadata.

---

## 5.2 Authentication endpoints

### `POST /api/auth/login`
Login endpoint.

No auth required.

Request body:

```json
{
  "username": "string",
  "password": "string"
}
```

Special behavior:

- If `Accept` indicates JSON API client, response includes bearer token
- Otherwise cookie-based browser auth is used

Response:

```json
{
  "success": true,
  "message": "Login successful",
  "csrfToken": "...",
  "user": {
    "id": 1,
    "username": "admin",
    "email": "...",
    "role": "admin",
    "displayName": "System Admin",
    "isSystemUser": false
  },
  "token": "<bearer-access-token>",
  "authMethod": "bearer_token"
}
```

If browser mode, `token` may be omitted and `authMethod` will be `httponly_cookie`.

### `GET /api/auth/status`
Returns current login state.

Auth: optional

Response when logged in:

```json
{
  "authenticated": true,
  "user": { ... },
  "csrfToken": "..."
}
```

Response when not logged in:

```json
{ "authenticated": false }
```

### `POST /api/auth/logout`
Logs out the current user.

Auth: required
CSRF: required

Behavior:

- validates CSRF token
- increments token version for DB users
- clears auth cookies
- sends `Clear-Site-Data: "cookies"`

Response:

```json
{ "success": true, "message": "Logged out successfully" }
```

### `POST /api/auth/refresh`
Refreshes access token using the refresh cookie.

No auth header required, but cookie required.

Response:

```json
{
  "success": true,
  "csrfToken": "...",
  "user": { ... }
}
```

---

## 5.3 Player endpoints

### `GET /api/players`
Returns all players.

Auth: optional / session-aware

Response: array of player records.

Typical player object:

```json
{
  "id": 1,
  "name": "Player Name",
  "created_at": "..."
}
```

### `POST /api/players`
Create a player.

Auth: admin only
CSRF: required

Request:

```json
{ "name": "Player Name" }
```

Response:

```json
{ "success": true, "id": 123, "name": "Player Name" }
```

### `DELETE /api/players/:id`
Delete a player.

Auth: admin only
CSRF: required

Behavior:

- removes related matches first
- then deletes the player
- invalidates player/match/ranking caches

Response:

```json
{ "success": true, "message": "Player removed successfully" }
```

---

## 5.4 Season endpoints

### `GET /api/seasons`
List all seasons.

Auth: optional / session-aware

### `GET /api/seasons/active`
List all active seasons.

Auth: optional / session-aware

### `GET /api/seasons/active-one`
Returns the latest active season or `null`.

Auth: optional / session-aware

### `GET /api/seasons/:id/players`
Lists players assigned to a season.

Auth: optional / session-aware

### `POST /api/seasons`
Create a season.

Auth: admin only
CSRF: required

Request fields:

```json
{
  "name": "Season Name",
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD or null",
  "autoEnd": true,
  "description": "optional",
  "loseMoneyPerLoss": 20000,
  "playerIds": [1, 2, 3]
}
```

Rules:

- if `autoEnd` is true, `endDate` must be set
- players can be attached at creation

### `PUT /api/seasons/:id`
Update a season.

Auth: admin only
CSRF: required

Request is similar to create.

### `POST /api/seasons/:id/players`
Replace season player roster.

Auth: editor or admin
CSRF: required

Request:

```json
{ "playerIds": [1, 2, 3] }
```

### `POST /api/seasons/:id/players/:playerId`
Add one player to a season.

Auth: editor or admin
CSRF: required

### `DELETE /api/seasons/:id/players/:playerId`
Remove one player from a season.

Auth: editor or admin
CSRF: required

### `POST /api/seasons/:id/end`
End a season.

Auth: editor or admin
CSRF: required

Request:

```json
{ "endDate": "YYYY-MM-DD" }
```

If omitted, server uses today.

### `POST /api/seasons/:id/reactivate`
Re-activate a season.

Auth: editor or admin
CSRF: required

### `DELETE /api/seasons/:id`
Delete a season.

Auth: admin only
CSRF: required

Rules:

- active seasons cannot be deleted until ended

### `POST /api/seasons/check-expired`
Checks for expired seasons and auto-ends them.

Auth: editor or admin
CSRF: required

---

## 5.5 Match endpoints

### `GET /api/matches`
Returns matches.

Auth: optional / session-aware

Query:

- `limit` optional integer `1..1000`

Behavior:

- with `limit`, cached list path
- without `limit`, server may stream from DB for large datasets

### `GET /api/matches/by-date/:date`
Matches for one date.

Auth: optional / session-aware

Date format: `YYYY-MM-DD`

### `GET /api/matches/by-season/:seasonId`
Matches for one season.

Auth: optional / session-aware

### `GET /api/matches/:id`
Single match details.

Auth: optional / session-aware

### `POST /api/matches`
Create a match.

Auth: editor or admin
CSRF: required

Request shape:

```json
{
  "seasonId": 1,
  "playDate": "YYYY-MM-DD",
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

For solo matches:

- `matchType = "solo"`
- `player2Id = null`
- `player4Id = null`
- `player1Id` and `player3Id` are the two opponents

Rules:

- players must be different
- season player restrictions are enforced if the season has an assigned roster
- `winningTeam` must be `1` or `2`

Response:

```json
{ "success": true, "id": 123 }
```

### `PUT /api/matches/:id`
Update a match.

Auth: editor or admin
CSRF: required

Same payload as create.

### `DELETE /api/matches/:id`
Delete a match.

Auth: editor or admin
CSRF: required

### `GET /api/matches/play-dates/list`
Returns distinct play dates.

Auth: optional / session-aware

### `GET /api/matches/play-dates/latest`
Returns the latest play date.

Auth: optional / session-aware

Response:

```json
{ "playDate": "YYYY-MM-DD" }
```

---

## 5.6 Rankings endpoints

### `GET /api/rankings/lifetime`
Lifetime rankings.

Auth: optional / session-aware

### `GET /api/rankings/season/:seasonId`
Season rankings.

Auth: optional / session-aware

### `GET /api/rankings/date/:date`
Daily rankings up to a given date.

Auth: optional / session-aware

Ranking entries generally include:

- `id`
- `name`
- `wins`
- `losses`
- `total_matches`
- `points`
- `win_percentage`
- `money_lost`
- sometimes `form`

Scoring rule used in the code:

- win = 4 points
- loss = 1 point

---

## 5.7 Export endpoints

### `GET /api/export-excel`
Export all matches/rankings as Excel.

Auth: editor or admin
CSRF: not needed for GET
Rate limited: yes

### `GET /api/export-excel/date/:date`
Export a single day.

Auth: editor or admin

### `GET /api/export-excel/season/:seasonId`
Export a season.

Auth: editor or admin

### `GET /api/export-excel/lifetime`
Export lifetime rankings.

Auth: editor or admin

Mobile note: this is probably not needed for the app, but it is part of the backend contract.

---

## 5.8 Backup and restore endpoints

### `GET /api/backup`
Full JSON backup including users.

Auth: admin only
CSRF: not needed for GET

### `POST /api/restore`
Full JSON restore.

Auth: admin only
CSRF: required
Large JSON body allowed

### `DELETE /api/clear-all-data`
Deletes all tennis data.

Auth: admin only
CSRF: required
Dangerous endpoint.

---

## 5.9 Admin analytics endpoints

### `GET /api/admin/access-stats?hours=24`
Access log statistics.

Auth: admin only

### `GET /api/admin/access-logs`
Returns a metadata response pointing to log files.

Auth: admin only

Query:

- `limit`
- `offset`
- `ip`
- `user`
- `path`

### `GET /api/admin/ip-analysis?ip=...`
Simple IP analysis response.

Auth: admin only

### `GET /api/admin/active-sessions`
Returns current request/session info.

Auth: admin only

### `GET /api/admin/security-dashboard`
System/security summary endpoint.

Auth: admin only

---

## 5.10 User management endpoints

These are admin-only and mainly relevant if the mobile team also needs admin account management.

### `GET /api/auth/users`
List users.

Auth: admin only

### `GET /api/auth/users/:id`
Get one user.

Auth: admin only

### `POST /api/auth/users`
Create user.

Auth: admin only
CSRF: required

Request:

```json
{
  "username": "editor1",
  "password": "secret123",
  "email": "editor@example.com",
  "role": "editor",
  "displayName": "Editor One",
  "notes": "optional"
}
```

### `PUT /api/auth/users/:id`
Update user profile/role/active state.

Auth: admin only
CSRF: required

### `PUT /api/auth/users/:id/password`
Change user password.

Auth: admin only
CSRF: required

### `DELETE /api/auth/users/:id`
Delete user.

Auth: admin only
CSRF: required

---

## 6) Data model

### 6.1 Core tables

#### `players`
- `id`
- `name`
- `created_at`

Rules:

- name is unique

#### `seasons`
- `id`
- `name`
- `start_date`
- `end_date`
- `is_active`
- `auto_end`
- `description`
- `lose_money_per_loss`
- `created_at`
- `ended_at`
- `ended_by`

Rules:

- multiple seasons can exist
- multiple seasons can be active at once
- season can auto-end when end date has passed

#### `season_players`
- `id`
- `season_id`
- `player_id`
- `added_at`
- `added_by`

Rules:

- unique pair `(season_id, player_id)`
- controls player eligibility for a season

#### `matches`
- `id`
- `season_id`
- `play_date`
- `player1_id`
- `player2_id`
- `player3_id`
- `player4_id`
- `team1_score`
- `team2_score`
- `winning_team`
- `match_type`
- `created_at`

Rules:

- `match_type` must be `solo` or `duo`
- solo match: `player2_id` and `player4_id` must be null
- duo match: `player2_id` and `player4_id` must be present
- team players must be different

#### `users`
Created by the account migration and used for database-backed login.

Columns from the migration:

- `id`
- `username`
- `email`
- `password_hash`
- `role`
- `display_name`
- `is_active`
- `created_at`
- `updated_at`
- `last_login`
- `created_by`
- `notes`
- `token_version` is added by a later migration

### 6.2 Summary / stats data

The code queries precomputed or summary-backed stats such as:

- `player_lifetime_stats`
- `player_season_stats`

These are used for rankings and forms, and are kept current via database triggers / summaries.

### 6.3 Ranking math

For daily / raw stats queries the app uses:

- wins: +4 points each
- losses: +1 point each
- money lost: season-configurable penalty per loss, default `20000`

Lifetime and season rankings are sorted primarily by points, then win percentage, then name.

---

## 7) Cache, realtime, and invalidation behavior

### 7.1 Redis cache

The server caches common queries in Redis:

- lifetime rankings
- players
- seasons
- active seasons
- play dates
- latest play date
- season-specific rankings and matches
- date-specific rankings and matches

### 7.2 Data version

The cache also maintains a global data version.

When data changes:

- PostgreSQL trigger emits `NOTIFY cache_invalidation`
- Redis updates or invalidates affected keys
- the data version changes
- SSE clients receive a version event

### 7.3 Client behavior

The web frontend:

- listens to SSE
- clears local caches when version changes
- reloads the current view

For mobile, recommended strategy:

- keep a small local cache
- use `/api/data-version` or SSE to know when to refresh
- refresh affected screens after successful writes

---

## 8) Security details the mobile team should know

### 8.1 Security middleware

The backend uses:

- Helmet headers
- CORS allowlist
- CSRF protection
- request timeout
- rate limiting
- input validation via `express-validator`
- bcrypt password hashing

### 8.2 CORS

CORS is enabled with credentials.

Mobile apps are usually not limited by browser CORS, but any embedded webview or browser-based shell is.

### 8.3 Rate limiting

Rate limiting is Redis-backed and may adapt to system load.

Important for the mobile team:

- do not hammer the server with polling
- prefer caching and SSE/push where possible
- use init/bootstrap intelligently

### 8.4 Payload validation

The server rejects invalid inputs with `400` responses and validation details.

### 8.5 CSRF requirement for write operations

This is the biggest integration detail for mobile:

- all POST/PUT/DELETE requests need `X-CSRF-Token`
- the token is derived from a cookie-backed session id
- therefore the app must preserve cookies

---

## 9) Recommended mobile integration approach

### Option A — Recommended: cookie jar + bearer token

Use this if the mobile framework has good cookie support.

Flow:

1. call `POST /api/auth/login` with `Accept: application/json`
2. store returned bearer token
3. persist cookies from the response
4. on future requests:
   - send `Authorization: Bearer <token>`
   - send cookies automatically via cookie jar
   - send `X-CSRF-Token` for writes
5. refresh access using `POST /api/auth/refresh` when needed

Why this is best:

- works with current backend as-is
- preserves CSRF flow
- preserves refresh flow
- supports access-token auth for API calls

### Option B — Cookie-only session emulation

Possible, but not ideal for a native mobile app.

- use cookies for everything
- use CSRF token from login / status / csrf-token endpoint
- maintain cookie jar carefully

### Option C — Bare bearer-token only

Not sufficient without backend changes.

Reason:

- bearer token works for access-authenticated endpoints
- but CSRF still requires the cookie-backed session id
- refresh also currently expects cookie storage

So this option would need backend changes.

---

## 10) Suggested mobile app API flow

### 10.1 App startup

1. determine API base URL
2. call `GET /api/init`
3. if authenticated, store user state and CSRF token
4. render main screens from bootstrap data
5. optionally open SSE or poll version endpoint

### 10.2 Login

1. call `POST /api/auth/login`
2. if successful:
   - store bearer token if provided
   - keep cookies
   - store CSRF token
   - refresh bootstrap data

### 10.3 Record a match

1. ensure user is authenticated and has editor/admin role
2. obtain current CSRF token
3. call `POST /api/matches`
4. on success, refresh:
   - current match list
   - rankings for the current mode
   - play dates
   - data version or SSE subscription

### 10.4 Update season/player data

After create/update/delete operations, refresh affected screens only:

- players
- seasons
- season players
- rankings
- match list

### 10.5 Logout

1. call `POST /api/auth/logout` with CSRF token
2. clear local auth state
3. clear local cache
4. optionally clear stored cookies if your framework does not do this automatically

---

## 11) Practical implementation notes for the mobile team

- Treat `Accept: application/json` as important for login so the server returns a bearer token.
- Keep a cookie jar anyway, because the CSRF session is cookie-based.
- Use `GET /api/init` as the main bootstrap endpoint.
- Prefer `GET /api/rankings/...` and `GET /api/matches/...` for live screens.
- Use SSE or version polling for refresh signals.
- Handle `403` responses as likely CSRF/auth-state problems.
- Handle `401` responses as expired or revoked authentication.
- Handle `400` responses as validation errors and show details to the user.

---

## 12) Mobile-friendly endpoint shortlist

If the team only needs the minimum set to match the web app:

- `POST /api/auth/login`
- `GET /api/auth/status`
- `POST /api/auth/logout`
- `GET /api/init`
- `GET /api/players`
- `GET /api/seasons`
- `GET /api/seasons/active`
- `GET /api/seasons/:id/players`
- `GET /api/matches`
- `GET /api/matches/by-date/:date`
- `GET /api/matches/by-season/:seasonId`
- `POST /api/matches`
- `PUT /api/matches/:id`
- `DELETE /api/matches/:id`
- `GET /api/rankings/lifetime`
- `GET /api/rankings/season/:seasonId`
- `GET /api/rankings/date/:date`
- `GET /api/matches/play-dates/latest`
- `GET /api/data-version`
- `GET /api/events` if SSE is supported in the mobile stack

---

## 13) Operational notes

### Environment variables that matter most

- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`
- `DB_HOST`
- `REDIS_URL`
- `JWT_SECRET`
- `CSRF_SECRET`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `EDITOR_USERNAME`
- `EDITOR_PASSWORD`
- `SUBPATH` / `BASE_PATH`
- `PUBLIC_DOMAIN`
- `ALLOWED_ORIGINS`

### Database / migration notes

Important migration scripts found in the repo include:

- `apply-account-system-migration.sh` — creates the `users` table and related account features
- `migrations/add-token-version.sh` — adds token revocation support
- `migrations/add-cache-notify-triggers.sql` — sets up cache invalidation triggers

---

## 14) Final recommendation

For the mobile app, I recommend this implementation approach:

1. Use the existing backend as the API server.
2. Make the base URL configurable.
3. Login with `Accept: application/json` so the API returns a bearer token.
4. Persist cookies in the mobile client as well.
5. Use `X-CSRF-Token` for all write requests.
6. Use `/api/init` on startup to avoid multiple requests.
7. Refresh views with SSE or `GET /api/data-version`.
8. Keep the mobile app’s local cache small and invalidate it aggressively when the server version changes.

That will give the team the cleanest path to a native app that behaves like the current web app.

---

## 15) Notes from code inspection

This document was generated from live code inspection of the project files in `/home/vps/tennisranking`, including:

- `server.ts`
- `middleware/auth.ts`
- `middleware/csrf.ts`
- `config/env.ts`
- `config/cookie.ts`
- `lib/jwt-encryption.ts`
- `lib/redis-cache.ts`
- `database-postgresql.ts`
- `routes/*.ts`
- `src/api/client.ts` and `src/app/app-context.tsx`
- migration scripts

If you want, I can also turn this into:

- a shorter **API spec for engineers**
- a **mobile implementation checklist**
- or a **PDF version** for sharing
