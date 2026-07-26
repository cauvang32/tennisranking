# Repository Guidelines

## Project Structure & Module Organization

This is a tennis-ranking application: an Express/PostgreSQL/Redis API plus a vanilla-JavaScript Vite SPA. Backend entry points are `server.js` (HTTP app), `database-postgresql.js` (database adapter), and `worker.js` (FCM worker). Keep route handlers in `routes/`, cross-cutting services in `lib/`, configuration in `config/`, and middleware in `middleware/`. The frontend lives in `src/`: shared modules in `src/modules/`, feature code in `src/features/<feature>/`, and global styling in `src/style.css`. Put database changes in ordered, idempotent `migrations/`; put tests in `tests/` or `tests/unit/`.

## Build, Test, and Development Commands

- `npm install` installs dependencies (Node.js 22 is expected).
- `docker compose up -d postgres redis` starts local backing services.
- `npm run dev-full` runs Vite on port 5173 and Express on port 3001.
- `npm run build` writes the production frontend to `dist/`; `npm run server` starts the API.
- `npm test` runs the full Vitest suite; `npm run test:unit` limits it to unit tests; `npm run test:watch` is useful while developing.
- `npm run lint` checks backend, frontend, and tests with ESLint.

## Coding Style & Naming Conventions

Use ESM `import`/`export`, 2-space indentation, semicolons only where the surrounding file uses them, and English code/comments (the UI is Vietnamese). Name router factories `createXxxRouter` and inject dependencies from `server.js`; keep domain logic out of that thin entry point. Use lowercase kebab-case filenames where established (for example, `jwt-encryption.js`) and feature directories such as `src/features/cups/`.

Use parameterized database queries exclusively. Wrap asynchronous handlers with `asyncHandler`, validate input with `express-validator`, sanitize API responses, and invalidate the affected cache after mutations.

## Testing Guidelines

Write Vitest files as `*.test.js`, mirroring the area under test; focused backend tests belong in `tests/unit/`. Cover success paths, validation failures, and authorization/security behavior when applicable. Run `npm test` before opening a pull request; the repository does not define a coverage threshold.

## Commit & Pull Request Guidelines

Follow the existing Conventional Commit style: `feat: add cup brackets`, `fix: prevent stale closure`, or `chore: update dependencies`. Keep commits focused. Pull requests should explain the behavior change, list tests run, link related issues, and include screenshots for visible frontend changes. Call out migrations, configuration changes, or security-sensitive changes explicitly.

## Security & Configuration

Copy `.env.example` to `.env`; never commit secrets, credentials, uploaded data, or generated keys. Required authentication and CSRF secrets are validated at startup. Preserve cookie, CSRF, authorization, cache-invalidation, and parameterized-query patterns when modifying API behavior.
