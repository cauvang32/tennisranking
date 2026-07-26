# Security and Performance Audit — 2026-07-26

## Scope and Verification

This audit covered the Express API, authentication and CSRF flows, PostgreSQL schema bootstrap, Redis caching, uploads, exports, worker health, Docker Compose, and GitLab CI. Verification included Vitest, ESLint, the Vite production build, `npm audit`, Docker Compose validation, and read-only inspection of the running PostgreSQL and Redis services.

## Remediation Status

The July hardening pass addressed the identified high-priority findings:

- API responses are `private, no-store`; conditional responses cannot complete before authorization.
- Production cookies are always Secure and SameSite Strict. Production CORS rejects `null`, HTTP, and malformed origins.
- Browser login never returns a JavaScript-readable bearer token. Refresh tokens use hashed, one-time database sessions with rotation and reuse rejection.
- Uploads use a persistent `UPLOAD_ROOT` outside Git, contained logical paths, UUID filenames, MIME signature validation, and validated route identifiers.
- Match changes invalidate lifetime, season, date, list, and detail caches. Redis versions use atomic `INCR`, and worker restarts no longer flush shared cache.
- Fresh database startup creates users before dependent device records. Schema work is serialized, and ordered SQL migrations have a checksum ledger.
- AI calls have hard timeouts and bounded image/output sizes. Exports and backups have explicit row limits.
- Cache Redis is isolated from persistent BullMQ and rate-limit state.
- CI tests, lint, production dependency audit, and build failures block deployment.
- Production media is copied to `/home/vps/tennisranking-data/uploads` before Git reset and is served from that persistent location.

## Operational Requirements

Set `UPLOAD_ROOT`, exact HTTPS `ALLOWED_ORIGINS`, `TRUST_PROXY`/`TRUST_PROXY_HOPS`, and separate Redis URLs according to `.env.example`. Run `npm run migrate` before starting new application processes. Configure the Redis host with `vm.overcommit_memory=1`, monitor queue AOF disk use, and verify `/ready` before routing traffic.

## Residual Risk

Static review cannot prove the absence of vulnerabilities. Production releases still require image scanning, secret scanning, database backups, reverse-proxy validation, and load testing with realistic data volumes. Any dependency advisory exception must document reachability, an owner, and an expiry date.
