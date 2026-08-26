# TypeScript and React Migration

## Status

The application has been migrated from a vanilla-JavaScript Vite frontend and JavaScript Node.js runtime to:

- React 19 with TypeScript for the browser application;
- TypeScript source for Express, PostgreSQL, Redis, migrations, tests, and the FCM worker;
- compiled, immutable production artifacts in `dist/` and `build/`;
- CI/CD validation and rollback that treats those two artifacts as one release.

No database schema migration is required for this change. Existing PostgreSQL data, Redis keys, uploaded media, cookie names, API paths, and roles are retained.

## Why this shape

React is used only for the view and client-state layer. Express remains the API and production static-file server, so the migration does not introduce server-side rendering, a second backend, or a new routing tier. The existing tab-oriented UI is preserved in the React app shell.

TypeScript is split into runtime-specific projects instead of using one configuration everywhere:

| Project | Scope | Policy |
|---|---|---|
| `tsconfig.app.json` | React client and shared contracts | Strict, no emit, Vite/Bundler resolution |
| `tsconfig.server.json` | Express, worker, routes, services, database, scripts | NodeNext emit to `build/`; compatibility mode for migrated legacy internals |
| `tsconfig.tools.json` | Vite config and Vitest tests | No emit; DOM/Node/test types |

The frontend and shared contracts are strict now. The server compiles with compatibility flags because forcing strictness across the large legacy database adapter and dependency-injection contexts in the same release would obscure functional migration risk. New server code should still be explicitly typed; strictness can be tightened module-by-module later.

## Source mapping

| Before | After |
|---|---|
| `index.html` contained the complete application markup | Minimal `index.html` mounts `src/main.tsx` into `#root` |
| `src/main.js` plus `src/modules/*.js` | `src/app/`, `src/api/`, and shared React components |
| `src/features/**/*.js` with direct DOM mutation | `src/features/**/**Feature.tsx` with local React state |
| Browser auth, CSRF, cache, and SSE modules | Typed `src/api/client.ts` and `src/app/app-context.tsx` |
| `server.js`, `worker.js`, `database-postgresql.js` | TypeScript source with the same `.ts` basenames |
| `routes/*.js`, `lib/*.js`, `middleware/*.js` | TypeScript source with the same module boundaries |
| `tests/**/*.test.js` | `tests/**/*.test.ts` plus React `*.test.tsx` |
| Production executed source JavaScript | Production executes `build/server.js`, `build/worker.js`, and compiled migration scripts |

Backend imports intentionally end in `.js`, for example `import config from './config/env.js'`. This is required for standards-compliant ESM output; NodeNext resolves the source `.ts` file during compilation.

## Frontend behavior retained

The React feature components cover:

- daily, seasonal, and lifetime rankings with Excel export;
- singles/doubles match creation, edit/delete, batch entry, history, and image parsing;
- player CRUD;
- season CRUD, rosters, activation/end flow, final text, and conclusion images;
- cup CRUD, participants/seeding, bracket generation, status transitions, scoring, dates, reset, and conclusion data;
- account/role management, Redis/FCM administration, and broadcast notifications;
- site-image management;
- JSON backup, restore, and clear-all administration.

The typed API client preserves cookie authentication and CSRF protection. It fetches a CSRF token before mutations and performs a single refresh-and-retry for an expired access session. Role checks in React affect presentation only; server authorization remains authoritative.

SSE remains the primary coherence channel. A data-version change reloads the bootstrap payload. A polling fallback starts only after EventSource failure and stops when the component is disposed.

### UI and theme compatibility

The React components reuse the design tokens in `src/style.css`; React-specific layout and component bindings live in `src/react.css`. This separation preserves the existing branding while styling React-only class names for ranking controls, tables, cards, forms, modals, and responsive layouts. Both light and operating-system dark themes use the same token set, so new React components should use variables such as `--surface`, `--bg`, `--border`, and `--text` instead of introducing duplicate color literals or undeclared aliases.

## Local workflow

Requirements remain Node.js 22, PostgreSQL, and Redis.

```bash
npm install
docker compose up -d postgres redis redis-queue
npm run dev-full
```

Useful checks:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run check
```

`npm run build` creates both required release directories:

- `dist/`: hashed React browser assets and `index.html`;
- `build/`: compiled Node.js modules, server, worker, and migration runners.

Run production locally only after building:

```bash
npm run build
NODE_ENV=production npm run server
```

For source-level migration troubleshooting, `npm run server:source` and `npm run migrate:source` execute TypeScript through `tsx`.

`npm start` is also valid for a production-style local run: it rebuilds both targets and then starts Express. Use `npm run dev-full` for normal development because it provides Vite and server hot reload. Open the configured base path after startup (for example, `http://localhost:3001/tennis/` when `BASE_PATH=/tennis/`); opening only the root path may redirect depending on the environment configuration.

## CI/CD changes

### GitHub Actions

The K3s image workflow now installs with `npm ci`, then runs lint, TypeScript checks, Vitest, and both builds before Buildx. Pull requests build but do not push; main/tag pushes publish the image as before.

### GitLab CI and PM2

GitLab has a dedicated type-check job. Its build job publishes both `dist/` and `build/`. The deploy job:

1. snapshots the currently deployed `dist/` and `build/` under the current Git SHA;
2. resets the deployment checkout to the selected main-branch revision;
3. installs production dependencies;
4. copies the tested `build/` artifact and runs the compiled migration runner;
5. copies the tested `dist/` artifact;
6. restarts the worker and PM2, which now executes `build/server.js`;
7. saves both artifacts as the rollback release for the new SHA.

Rollback requires both `dist/index.html` and `build/server.js`, restores both immutable artifacts, runs the matching compiled migration runner, and restarts services. This prevents a new browser bundle from being paired with an old server runtime or vice versa.

### Containers and K3s

- `Dockerfile` is a multi-stage worker build. It compiles TypeScript, installs production-only dependencies in the runtime stage, drops root, and starts `build/worker.js`.
- `Dockerfile.k3s` builds React and Node.js artifacts once. The runtime image contains `dist/`, `build/`, `migrations/`, public assets, and production dependencies.
- The K3s API command uses `build/server.js`; the worker uses `build/worker.js`; the migration Job uses `build/scripts/migrate-k3s.js`.

## Deployment checklist

Before merging or deploying:

- [ ] `npm ci` succeeds on Node.js 22.
- [ ] `npm run check` succeeds.
- [ ] `dist/index.html` and `build/server.js` exist.
- [ ] The image builds with the intended `BASE_PATH` (`/tennis/` in production).
- [ ] Required environment variables and secrets are present; no secrets are baked into artifacts.
- [ ] PostgreSQL and all Redis endpoints are reachable.
- [ ] The migration Job completes before the new API rollout.
- [ ] `/health`, `/api/init`, login, a CSRF-protected mutation, and `/api/events` are smoke-tested.
- [ ] The FCM worker health check becomes healthy.
- [ ] The prior release has both `dist/` and `build/` snapshots before rollout.

## Rollback

The code migration itself has no data conversion to reverse. Roll back the application as an artifact pair:

1. stop PM2;
2. select the prior release SHA;
3. restore that SHA's `dist/` and `build/` directories;
4. install dependencies from the matching `package-lock.json`;
5. run its compiled migration runner (migrations are idempotent);
6. rebuild/restart the matching worker image and restart PM2;
7. verify health, login, rankings, and SSE.

Do not restore only `dist/` or only `build/`. Uploaded media remains under the persistent upload root and PostgreSQL/Redis remain external to these artifacts.

## Follow-up hardening

The migration establishes typed boundaries and a strict React codebase. Recommended incremental work is to replace compatibility types in `database-postgresql.ts`, route dependency contexts, and Redis internals with explicit interfaces, then enable full `strict` and `noUncheckedIndexedAccess` in `tsconfig.server.json`. This is follow-up hardening, not required to operate the migrated release.
