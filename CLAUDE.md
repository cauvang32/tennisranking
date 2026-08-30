# CLAUDE.md

This repository is a TypeScript tennis-ranking application: React 19/Vite in the browser and Express 5/PostgreSQL/Redis on the server. Read `AGENTS.md` for contribution rules, `README.md` for product/API documentation, `docs/architecture.md` for current design, and `docs/typescript-react-migration.md` for the JavaScript migration history.

## Commands

```bash
npm install
docker compose up -d postgres redis redis-queue
npm run dev-full          # Vite HMR + server.ts through tsx watch
npm run lint
npm run typecheck
npm test
npm run build             # dist/ browser artifact + build/ Node artifact
npm run check             # complete local validation
npm run server            # node build/server.js (build first)
```

Node.js 22 is expected. Production never executes TypeScript source directly.

## Code layout

- `server.ts` is the composition root; keep domain behavior in injected route/service modules.
- `databases/postgresql/` is the production database adapter (split by domain: `core`, `schema`, `players`, `seasons`, `matches`, `rankings`, `users`, `devices`, `data`, `images`, `cups`, `backup`; composed in `index.ts`). Use parameterized SQL only.
- `config/`, `lib/`, `middleware/`, `routes/`, and `utils/` contain backend TypeScript.
- `src/app/` owns the React shell and application context; `src/api/` owns HTTP/auth/CSRF behavior; `src/components/` contains shared UI; `src/features/` contains feature components.
- `shared/domain.ts` holds browser/server contracts.
- `worker.ts` is the BullMQ FCM worker.
- `tests/unit/` contains backend tests and `tests/frontend/` contains React/jsdom tests.

Backend relative imports use `.js` suffixes intentionally for NodeNext ESM output even though source files are `.ts`.

## Critical patterns

- Every router exports a `createXxxRouter` factory and receives its dependencies from `server.ts`.
- Wrap asynchronous handlers with `asyncHandler`; validate with `express-validator`; sanitize responses.
- Explicitly invalidate the affected cache after every mutation. PostgreSQL `LISTEN/NOTIFY` remains the cross-process safety net.
- Keep authentication, authorization, CSRF, cookie, refresh rotation, rate limiting, and token revocation enforced on the server. React role checks are presentational only.
- Clear auth cookies with `clearCookieAllPaths` because historical deployments used multiple paths.
- The React API client is the single browser HTTP boundary. It sends credentials, attaches CSRF tokens to mutations, performs one refresh retry, and handles root or `/tennis/` base paths.
- React synchronization uses SSE and falls back to polling `/api/data-version` only after EventSource failure.

## Build and deployment

Vite writes `dist/`; TypeScript writes the server, worker, database adapter, routes, and migration runners to `build/`. PM2 starts `build/server.js`, Compose/K3s starts `build/worker.js`, and the K3s migration Job starts `build/scripts/migrate-k3s.js`. Always deploy or roll back `dist/` and `build/` together.

Required secrets are validated in `config/env.ts`; see `.env.example`. Never commit secrets, upload data, generated keys, or database dumps.
