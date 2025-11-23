<!-- Workspace-specific guardrails for AI coding agents -->

# Tennis Ranking System · AI Field Guide

## Architecture snapshot
- SPA frontend (`src/main.js`) runs on Vite and talks to an Express API (`server.js`) over `fetch` with `credentials: 'include'`; it auto-detects subpath deployments (e.g. `/tennis`) and falls back to offline localStorage mode when the API is unreachable.
- The backend is a hardened Node/Express service that fronts PostgreSQL via `database-postgresql.js`; it layers Helmet, custom rate limiters, CSRF tokens derived from `csrfSessionId`, encrypted JWT httpOnly cookies, and a manual cache (`RankingsCache`) for rankings/season queries.
- Data persists in PostgreSQL plus timestamped Excel snapshots (`data/`), while `ExcelJS` is used both server- and client-side for import/export.

## Backend patterns worth mirroring
- All mutating routes in `server.js` run through `authenticateToken` + `requireRole` + express-validator and call `rankingsCache.clear()` (followed by `preloadCommonData`) so new endpoints must do the same to keep rankings fresh.
- The API honors both `/api/...` and `${SUBPATH}/api/...`; when adding routes, register them once and rely on the normalization middleware that trims the subpath.
- Role gates: admins manage everything, editors can post/update/delete matches/seasons, guests are read-only. Use `requireAdmin` / `requireEditor` helpers instead of ad-hoc checks.
- Database access lives in `database-postgresql.js` only—extend that class (and corresponding SQL migrations under `migration-*.sql`) rather than issuing raw queries from route files.
- Access logging pipelines through `logAccess`/`logError` (`access-logger.js`); include context when catching errors so the audit trail stays useful.

## Frontend conventions (`src/main.js`)
- `TennisRankingSystem` is the single orchestrator: call `this.makeAuthenticatedRequest()` for any write so CSRF headers are injected automatically and stateful cookies remain synced.
- UI gating relies on CSS classes (`.edit-only`, `.admin-only`, `.editor-only`, `.guest-info`); when adding new controls, toggle those classes in `updateUIForAuthStatus()` rather than duplicating permission logic.
- View modes (daily/season/lifetime) are simple DOM sections—hide/show them via `hideAllViewModeSections()` and `switchTab()` to avoid layout glitches.
- When server mode is unavailable the class switches to `localStorage` persistence; keep that fallback in mind when touching init/load flows (avoid assuming `apiBase` exists).

## Data, seasons, and Excel
- Seasons are first-class records with auto-end logic and reactivation (see `MULTI_SEASON_FEATURE.md` + `database-postgresql.js`); any new stats endpoints should accept a `seasonId` arg to stay consistent.
- Excel exports live in `/api/export-excel` and mirror the workbook structure in `createExcelData()`—update both spots if you add new columns so UI/server stay aligned.
- Shared Excel backups land under `data/` (documented in `data/README.md`); don’t hand-delete files because the client loads “latest by timestamp” on startup.

## Build, run, deploy workflows
- `npm run dev` starts the Vite UI (port 5173), `npm run server` starts Express (port 3001), and `npm run dev-full` runs both via `concurrently`—use the last one for end-to-end work.
- `BASE_PATH` toggles subpath builds (`npm run build:subpath` for `/tennis`, `npm run build:subdomain` for root). Production deploy scripts (`deploy:subpath`, `deploy:subdomain`) bake both `BASE_PATH` and `NODE_ENV`.
- DB setup helpers (`setup-postgresql.sh`, `prepare-postgres-data.sh`, `migrate-database*.js`, `verify-season-schema.sql`) assume environment variables `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_SSL` are present—server startup will exit early if any are missing.

## Security-first defaults
- Cookies are `httpOnly`, `secure` (unless overridden for local dev), and tied to a configurable domain; the CSRF secret is derived via HMAC per-session. Keep these helpers (`withCookieDefaults`, `deriveCSRFSecret`) when extending auth flows.
- Rate limiting is environment-aware (disabled in dev) and proxy-safe via `getRealClientIP`; any new heavy endpoint should wrap `conditionalRateLimit(createLimiter|deleteLimiter|exportLimiter)` as appropriate.
- CSP is strict—avoid inline scripts/styles; add new origins in the Helmet config inside `server.js` if absolutely necessary.

## Handy references
- `server.js` – routing, security middleware, cache invalidation patterns.
- `database-postgresql.js` – SQL schema plus helpers for players/seasons/matches stats.
- `src/main.js` & `src/style.css` – client logic and responsive design system.
- `MULTI_SEASON_FEATURE.md`, `SECURITY_AUDIT_REPORT.md`, `COOKIE_SECURITY_AUDIT.md` – rationale behind schema/security choices.
- `Dockerfile`, `docker-compose.yml`, `SUBPATH_DEPLOYMENT_GUIDE.md` – deployment topologies.

Clarify or extend any section that still feels ambiguous, and keep this guide updated when workflows or dependencies change.
