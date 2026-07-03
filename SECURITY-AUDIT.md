# 🔒 Tennis Ranking System — Security & Reliability Audit

**Date:** 2026-07-02
**Scope:** Full codebase review (server, routes, middleware, database, config, AI parser)
**Auditor:** Claw (automated code review)

---

## Summary

| Severity | Count | Status |
|----------|-------|--------|
| 🔴 Critical | 4 | New findings |
| 🟠 High | 5 | New findings |
| 🟡 Medium | 6 | Mixed (1 pre-existing, 5 new) |
| 🔵 Low / Efficiency | 7 | Mixed (2 pre-existing, 5 new) |

**Total: 22 findings** (4 pre-existing from prior audits, 18 new)

---

## 🔴 Critical

### C1. JWT Not Invalidated on User Deletion

**File:** `database-postgresql.js`, `routes/users.js`
**Lines:** `deleteUser()` (~line 800), `DELETE /api/auth/users/:id`

Deleting a user does NOT increment `token_version`. Existing JWTs for that user remain valid until natural expiry (15 min access / 7 day refresh). The auth middleware checks `tokenVersion` mismatch, but since the version never changes on delete, the check passes.

**Failure scenario:** Admin deletes user "malicious-editor". That user's refresh token (7-day lifetime) continues to work. They can re-authenticate, get new access tokens, and keep editing matches — despite being "deleted".

The auth middleware DOES check `currentVersion === null` (user deleted from DB), which would catch this. HOWEVER — the env-based admin/editor accounts (hungsanity, Neonguyen) don't have DB `id` fields, so the revocation check is skipped entirely for them. Deleting a DB user who happens to share the env admin username creates a race window.

**Fix:** Add `await db.incrementTokenVersion(userId)` before `DELETE FROM users` in `deleteUser()`.

```js
// database-postgresql.js — deleteUser()
async deleteUser(userId) {
  // Invalidate all existing JWTs for this user
  await this.query(`
    UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = $1
  `, [userId])
  await this.query('DELETE FROM users WHERE id = $1', [userId])
}
```

---

### C2. Backup Restore Imports Password Hashes Without Verification

**File:** `routes/backup.js`, `POST /api/restore`
**Lines:** ~80-110

The full restore endpoint imports `password_hash` directly from backup JSON into the `users` table with zero verification. A malicious or corrupted backup file with modified password hashes would silently reset user passwords. There's no hash integrity check, no confirmation prompt comparing restored hashes against known-good values, and no audit trail of which users had passwords changed during restore.

**Failure scenario:** Backup file is tampered in transit (e.g., S3 bucket compromise, man-in-the-middle on download). Attacker changes admin password hash. Admin restores backup. Attacker now has admin access with the new password. The original admin is locked out with no way to recover.

**Fix:** Either (a) require password re-confirmation for all users after restore, (b) add a backup signature/HMAC check, or (c) at minimum log which users were restored with password hashes and require admin acknowledgment.

---

### C3. Player Name Regex Allows Log Injection / Header Injection

**File:** `routes/players.js`
**Line:** `.matches(/^[a-zA-Z0-9\s\u0080-\uFFFF]+$/)`

The `\s` character class includes `\n`, `\r`, `\t`, and other whitespace. Player names with newlines can be injected, which:
1. **Injects into access logs** — a player named `An\r\n192.168.1.1 - - [fake] "GET /admin HTTP/1.1" 200 0` creates forged log entries
2. **Potential HTTP header injection** if the name is ever reflected in response headers
3. **Breaks log parsing** — structured log parsers (Grok, Fluentd) will split on newlines

**Failure scenario:** Admin creates player "An\nFake". All log lines containing this player's name are split, breaking log aggregation, SIEM alerts, and audit trails.

**Fix:** Replace `\s` with explicit safe whitespace: `/^[a-zA-Z0-9 \u0080-\uFFFF]+$/` (space only, no newlines).

---

### C4. AI API Key in Error Responses

**File:** `lib/ai-parser.js`
**Lines:** Multiple fetch calls include `Authorization: Bearer ${AI_API_KEY}` headers

The AI API key is used in fetch calls to the vision API. If the AI API returns an error (4xx/5xx), the error message from `response.text()` is passed directly to the user-facing response. While the key itself isn't in the response, the AI provider's error messages may reveal model names, rate limit details, or other infrastructure information. More critically, if `detectApiFormat()` fails with a network error, the catch blocks silently swallow errors — but if it partially succeeds, the probe response could leak configuration details.

**Failure scenario:** AI API returns 401 with message "Invalid API key: sk-...". The error is passed to the user as `502: AI API error 401: Invalid API key: sk-...`. The API key prefix is visible in the error response.

**Fix:** Sanitize AI error messages before returning to client. Strip any token-like patterns.

```js
if (!response.ok) {
  const text = await response.text()
  // Sanitize: strip any potential key leaks
  const sanitized = text.replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED]')
                         .replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]')
  throw new Error(`AI API error ${response.status}: ${sanitized}`)
}
```

---

## 🟠 High

### H1. CSRF Bypass on Login Endpoint

**File:** `middleware/csrf.js`
**Line:** `if (matchesApiRoute(req, '/api/auth/login')) return next()`

The login endpoint explicitly skips CSRF protection. While this is common (you need to issue a CSRF token before requiring one), it means the login endpoint is vulnerable to CSRF attacks. An attacker could create a page that auto-submits a POST to `/api/auth/login` with predetermined credentials, causing the victim's browser to authenticate as that user.

**Mitigating factors:** The `loginLimiter` (10 req/5min, essential) limits brute-force. Cookie-based auth with `SameSite=Strict` provides some CSRF protection. But SameSite is not a complete CSRF defense (it can be bypassed via email links, certain browsers, or if the victim is already on the domain).

**Fix:** Add one-time CSRF token for login (issued via GET /api/csrf-token before login form), or use a double-submit cookie pattern specifically for the login endpoint.

---

### H2. Backup Restore CSRF Bypass + No CSRF Token Required

**File:** `routes/backup.js`, `middleware/csrf.js`

The `POST /api/restore` endpoint is protected by `authenticateToken` + `requireAdmin`, but CSRF protection is applied globally via `globalCSRFProtection` middleware. The CSRF middleware checks `X-CSRF-Token` header or `_csrf` body field. If the frontend doesn't send a valid CSRF token with restore requests, the restore will be blocked. If it does send one, an attacker who compromises the admin's session cookie could trigger a restore via CSRF (though SameSite=Strict mitigates this).

**More critical:** The backup restore has NO rate limiting beyond `strictRestoreLimiter` (5 req/15min). A compromised admin account could restore a malicious backup 5 times in 15 minutes, each time wiping all data.

**Fix:** Add explicit confirmation step (e.g., require admin to type "RESTORE" or confirm current data will be lost). Consider adding a secondary auth factor for restore operations.

---

### H3. Environment-Based Accounts Bypass Token Revocation

**File:** `middleware/auth.js`, `config/env.js`

The env-based admin (hungsanity) and editor (Neonguyen) accounts authenticate via bcrypt password check against env vars, NOT via JWT token version checks. When these users log in, they get JWT tokens with `id: null` (no DB user ID). The auth middleware's token revocation check requires `user.id` to be truthy:

```js
if (user.id && db && typeof db.getTokenVersion === 'function') {
  // revocation check — SKIPPED for env users (id is null)
}
```

This means env-based admin/editor tokens can NEVER be revoked server-side. If an admin's device is stolen, their JWT remains valid for the full 15-minute access / 7-day refresh lifetime with no way to invalidate it.

**Fix:** Either (a) create DB user records for env accounts, or (b) add a global token revocation mechanism (e.g., Redis-based denylist) that works independently of user ID.

---

### H4. CORS Allowed Origins Include Path That Gets Stripped

**File:** `.env`, `config/env.js`

`ALLOWED_ORIGINS` includes `https://hungsanity.com/tennis` (with path). The config strips paths during validation:

```js
const url = new URL(o)
return `${url.protocol}//${url.host}`  // → "https://hungsanity.com"
```

The browser sends `Origin: https://hungsanity.com` (no path). The stripped config matches correctly. BUT the original env value with path is misleading — it suggests path-level CORS control that doesn't exist. If an attacker controls `https://hungsanity.com/evil`, they get the same CORS access as `https://hungsanity.com/tennis`.

**Impact:** Low in practice (same domain), but the misconfiguration could cause false security confidence. If the domain were ever shared or subdomain-based, this would be more serious.

**Fix:** Clean up `ALLOWED_ORIGINS` to use origin-only values. Document that CORS is origin-level, not path-level.

---

### H5. `detectApiFormat()` Probe Is Not Cached Across Requests

**File:** `lib/ai-parser.js`

The `detectApiFormat()` function sends probe requests to the AI API on first call. The result is cached in a module-level `apiFormat` variable. However, if the first probe fails (network error, timeout), `apiFormat` remains `null` and the function defaults to `'openai'`. Subsequent calls skip the probe entirely (the `if (apiFormat === null)` guard).

**Failure scenario:** At server startup, the AI API is temporarily unreachable. `detectApiFormat()` fails, `apiFormat` stays `null`. All subsequent image parse requests use OpenAI format against a local endpoint that expects LM Studio format. Every image parse silently fails or returns garbage.

**Fix:** On probe failure, explicitly set `apiFormat = 'openai'` (or the configured default) AND log a clear warning. Consider adding a retry mechanism or a manual override env var.

---

## 🟡 Medium

### M1. Cursor Pagination Broken (Pre-existing, `tracer-findings.json`)

**File:** `database-postgresql.js`, `getMatchesAfterId()`
**Line:** `WHERE m.id > $1` with `ORDER BY m.play_date DESC`

Already identified in `tracer-findings.json`. The cursor (last match ID) combined with date-descending sort means the same matches are returned repeatedly. Higher IDs don't correlate with newer dates.

**Status:** CONFIRMED BUG — needs fix.

**Fix:** Use composite cursor: `(play_date, id)` tuple comparison.

```sql
WHERE (m.play_date, m.id) < ($1, $2)
ORDER BY m.play_date DESC, m.id DESC
```

Pass both the last match's `play_date` AND `id` as cursor parameters.

---

### M2. Redis Reconnect Loop Can Cause Connection Storm

**File:** `lib/redis-cache.js`

The `scheduleReconnect()` method uses exponential backoff (5s → 10s → 20s → 40s → 60s → 60s...). However, `retryAttempt` is only reset on `connect` event, not on `ready`. If Redis accepts connections but fails readiness checks, `retryAttempt` keeps incrementing, causing increasingly long delays. More critically, if multiple PM2 workers are running, each independently reconnects, potentially overwhelming Redis on recovery.

**Fix:** Add jitter to reconnection delays. Consider coordinating reconnection across workers via Redis itself.

---

### M3. PostgreSQL Reconnect Loop Same Issue

**File:** `database-postgresql.js`

Same exponential backoff pattern without jitter. Multiple PM2 workers can cause a connection storm when PostgreSQL recovers from downtime.

**Fix:** Add random jitter (±25%) to reconnection delays.

---

### M4. Health Endpoint Exposes Infrastructure Details

**File:** `routes/health.js`

`GET /health` (public, no auth) returns PostgreSQL version, Redis status, pool sizes, and system memory. This information helps attackers identify specific CVEs for the running versions.

**Fix:** In production, return only `{"status":"ok"}` from the public health endpoint. Move detailed diagnostics to an admin-only endpoint.

---

### M5. `getRealClientIP()` Trust Chain Not Validated

**File:** `access-logger.js`

`getRealClientIP()` checks `CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`, and `req.ip`. If `trustProxy` is enabled (production), `req.ip` already parses `X-Forwarded-For`. The function then re-parses headers independently, potentially returning a different IP than Express's `req.ip`. This creates inconsistency: rate limiting uses `getRealClientIP()` but Express trust proxy uses `req.ip`. If a request has `X-Forwarded-For: attacker, proxy`, Express's `req.ip` returns `attacker` (first untrusted), but `getRealClientIP()` might return `proxy` (last in chain).

**Fix:** Use `req.ip` consistently when `trustProxy` is enabled. Only fall back to header parsing in non-proxy mode.

---

### M6. `invalidateOnMatchChange` Called Before Transaction Commit

**File:** `routes/matches.js`, `POST /api/matches`

When creating a match, `rankingsCache.invalidateOnMatchChange(playDate)` is called immediately after `db.addMatch()`. The `addMatch` uses the shared pool (auto-commit), so this is technically safe. However, the `PUT /api/matches/:id` update path invalidates cache BEFORE the response is sent. If the response fails to send (client disconnect), the cache is invalidated but the update succeeded — this is actually correct behavior. The real issue is with `bulk-create` where cache invalidation happens inside the loop, before the final COMMIT.

**Failure scenario:** Bulk create 10 matches. First 5 succeed, 6th fails. Transaction rolls back. But cache was already invalidated for dates 1-5. The cache now serves stale DB data (pre-bulk state) until the next preload cycle (4 minutes).

**Fix:** Move cache invalidation to AFTER successful COMMIT in bulk operations.

---

## 🔵 Low / Efficiency

### L1. `subpathNorm` Computed Twice (Pre-existing, `audit-findings.json`)

**File:** `server.js`, lines ~349 and ~363

Already identified. The SUBPATH normalization expression appears twice in `server.js`.

**Status:** CONFIRMED — low risk, easy fix.

---

### L2. `maxSsePerIp` Computed Per-Connection (Pre-existing, `efficiency-findings.json`)

**File:** `routes/system.js`, line ~128

Already identified. `Math.max(10, Math.floor(config.maxSseClients / 50))` runs on every SSE connection.

**Status:** CONFIRMED — hoist to module scope.

---

### L3. `Redis-Cache` Header Leaked in Production

**File:** `routes/seasons.js`, `routes/matches.js`, `routes/rankings.js`, etc.

Multiple routes use `res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')` with a guard `if (!config.isProduction)`. However, `routes/seasons.js` GET `/` and GET `/active` set the header unconditionally (no `isProduction` check). This leaks cache behavior to end users in production.

**Fix:** Add `if (!config.isProduction)` guard to ALL `Redis-Cache` header sets.

---

### L4. `getApiFormat` Probe Sends Real Request to AI API

**File:** `lib/ai-parser.js`

The format detection probe sends actual requests with `max_tokens: 10` to the AI API. For paid APIs (OpenAI), this burns tokens on every server restart. For rate-limited APIs, this consumes quota.

**Fix:** Add `AI_API_FORMAT` env var override. Default to `'openai'` for known providers. Only probe when explicitly configured.

---

### L5. Player Name Regex Rejects Common Vietnamese Names

**File:** `routes/players.js`

The regex `/^[a-zA-Z0-9\s\u0080-\uFFFF]+$/` allows Unicode characters but rejects hyphens, apostrophes, and dots. Vietnamese names like "Nguyen Van A" work, but names with hyphens (e.g., "Mary-Jane") or apostrophes (e.g., "O'Brien") are rejected. The season name regex is more restrictive: `/^[a-zA-Z0-9\s\u0080-\uFFFF.,-]+$/` — it allows commas and hyphens but not apostrophes.

**Impact:** Minor usability issue for international names.

**Fix:** Expand player name regex to include common name characters: `/^[a-zA-Z0-9\s\u0080-\uFFFF.'-]+$/`

---

### L6. No Input Length Validation on Match Scores

**File:** `routes/matches.js`

`body('team1Score').isInt({ min: 0 })` — no maximum. A user could submit `team1Score: 999999999`, which would be stored in the database and affect rankings calculations. While the DB column is `INTEGER` (max ~2.1 billion), extremely high scores could cause integer overflow in ranking calculations.

**Fix:** Add reasonable max: `.isInt({ min: 0, max: 999 })`

---

### L7. `Redis-Cache` Header Set on Non-GET Routes

**File:** `routes/seasons.js`

The `GET /seasons` and `GET /seasons/active` endpoints set `Redis-Cache` header unconditionally (no `!config.isProduction` check). The `GET /seasons/active-one` also lacks the guard. This is inconsistent with other routes that properly gate the header.

**Fix:** Add production guards to all cache header sets in `routes/seasons.js`.

---

## Appendix: Pre-existing Findings Status

| Finding | Source | Status |
|---------|--------|--------|
| `subpathNorm` duplication | `audit-findings.json` | Still present (L1) |
| Redis 5s connectTimeout | `efficiency-findings.json` | Partially fixed — `initRateLimitRedis` now has 120s timeout, but `connectTimeout: 5000` still in IORedis config |
| `maxSsePerIp` per-connection | `efficiency-findings.json` | Still present (L2) |
| `switchTab` async init | `efficiency-findings.json` | In frontend (`src/main.js`) — not in scope |
| `initRateLimitRedis` blocks startup | `tracer-findings.json` | Fixed — now has 120s timeout with graceful fallback |
| `getMatchesAfterId` cursor bug | `tracer-findings.json` | Still broken (M1) |
| `getVerificationKeyForVerify` key mismatch | `tracer-findings.json` | Fixed — now derives public key from private if only private is set |
| `sseCleanupInterval` hot-reload leak | `tracer-findings.json` | Still present — `createSystemRouter` called multiple times in dev creates duplicate intervals |

---

## Recommendations Priority

1. **Fix C1** (token invalidation on delete) — 1-line change, high security impact
2. **Fix C3** (player name regex) — prevents log injection, 1-line change
3. **Fix C4** (AI error sanitization) — prevents key leakage, small change
4. **Fix M1** (cursor pagination) — broken feature, needs SQL rewrite
5. **Fix H3** (env account revocation) — architectural change, higher effort
6. **Fix C2** (backup restore verification) — requires UX changes
7. **Fix H1** (login CSRF) — requires frontend changes
8. **Fix M6** (bulk cache invalidation) — move invalidation after commit

---

*This audit covers code as of 2026-07-02. Re-audit after significant changes.*
