# Repository Guidelines

## Project Structure & Module Organization

This is a tennis-ranking application: an Express/PostgreSQL/Redis TypeScript API plus a React/Vite TypeScript SPA. Source entry points are `server.ts` (HTTP app), `database-postgresql.ts` (database adapter), and `worker.ts` (FCM worker); production runs their compiled files from `build/`. Keep route handlers in `routes/`, cross-cutting services in `lib/`, configuration in `config/`, and middleware in `middleware/`. The frontend lives in `src/`: application state in `src/app/`, shared UI in `src/components/`, API access in `src/api/`, and feature components in `src/features/<feature>/`. Shared API/domain contracts live in `shared/`. Put database changes in ordered, idempotent `migrations/`; put tests in `tests/`, `tests/unit/`, or `tests/frontend/`.

## Build, Test, and Development Commands

- `npm install` installs dependencies (Node.js 22 is expected).
- `docker compose up -d postgres redis redis-queue` starts local backing services; use `docker compose up -d --build` when the worker image needs rebuilding.
- `npm run dev-full` runs Vite on port 5173 and Express on port 3001.
- `npm run build` type-checks and writes the frontend to `dist/` and the server runtime to `build/`; `npm run server` starts the compiled API.
- `npm test` runs the full Vitest suite; `npm run test:unit` limits it to unit tests; `npm run test:watch` is useful while developing.
- `npm run lint` checks backend, frontend, and tests with ESLint.
- `npm run typecheck` checks all TypeScript projects; `npm run check` runs the complete local validation sequence.

## Coding Style & Naming Conventions

Use ESM `import`/`export`, 2-space indentation, semicolons only where the surrounding file uses them, and English code/comments (the UI is Vietnamese). Use `.js` extensions in relative backend imports because NodeNext preserves them for compiled ESM. Name router factories `createXxxRouter` and inject dependencies from `server.ts`; keep domain logic out of that thin entry point. Use lowercase kebab-case filenames where established (for example, `jwt-encryption.ts`), PascalCase React component files, and feature directories such as `src/features/cups/`.

Use parameterized database queries exclusively. Wrap asynchronous handlers with `asyncHandler`, validate input with `express-validator`, sanitize API responses, and invalidate the affected cache after mutations.

## Testing Guidelines

Write Vitest files as `*.test.ts` or `*.test.tsx`, mirroring the area under test; focused backend tests belong in `tests/unit/` and React tests in `tests/frontend/`. Cover success paths, validation failures, and authorization/security behavior when applicable. Run `npm run check` before opening a pull request; the repository does not define a coverage threshold.

## Commit & Pull Request Guidelines

Follow the existing Conventional Commit style: `feat: add cup brackets`, `fix: prevent stale closure`, or `chore: update dependencies`. Keep commits focused. Pull requests should explain the behavior change, list tests run, link related issues, and include screenshots for visible frontend changes. Call out migrations, configuration changes, or security-sensitive changes explicitly.

## Security & Configuration

Copy `.env.example` to `.env`; never commit secrets, credentials, uploaded data, or generated keys. Required authentication and CSRF secrets are validated at startup. Preserve cookie, CSRF, authorization, cache-invalidation, and parameterized-query patterns when modifying API behavior.
