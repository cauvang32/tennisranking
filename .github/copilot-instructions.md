# Tennis Ranking — AI coding instructions

This is a TypeScript monorepo-style application with a React 19/Vite SPA and an Express 5/PostgreSQL/Redis API. Follow `AGENTS.md` and the current design in `docs/architecture.md`.

## Boundaries

- `server.ts` composes the application. Route factories in `routes/*.ts` receive database, cache, and middleware dependencies; do not import a global database from a route.
- `database-postgresql.ts` owns production SQL. Use parameters for every value and transactions with `client.release()` in `finally` for multi-step changes.
- `src/api/client.ts` is the browser HTTP boundary. Preserve cookie credentials, CSRF headers, refresh rotation, base-path handling, and typed contracts.
- `src/app/` owns global React state/SSE synchronization. Domain UI belongs in `src/features/<feature>/`; reusable UI belongs in `src/components/`.
- Shared request/response/domain contracts belong in `shared/domain.ts`.

Backend source imports use `.js` extensions intentionally because NodeNext must emit valid ESM. Do not change those specifiers to `.ts`.

## Security and correctness

- Wrap asynchronous Express handlers with `asyncHandler`.
- Validate input with `express-validator`, sanitize API responses, and keep authorization authoritative on the server.
- Preserve Secure HttpOnly cookies, CSRF enforcement on mutations, rotating refresh sessions, rate limits, and server-side revocation.
- Use `clearCookieAllPaths` for authentication cookies.
- Explicitly invalidate relevant Redis cache entries after mutations; PostgreSQL `LISTEN/NOTIFY` also propagates invalidation across processes.
- Keep UI labels Vietnamese and code/comments English.

## Validation

Use Node.js 22 and run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

React tests use Vitest, jsdom, and Testing Library under `tests/frontend/`. Backend tests use Vitest under `tests/unit/`.

Production executes compiled artifacts: `build/server.js`, `build/worker.js`, and `build/scripts/migrate-k3s.js`; Vite assets are in `dist/`. CI/CD and rollback must move `build/` and `dist/` together.
