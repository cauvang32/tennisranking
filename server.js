#!/usr/bin/env node

/**
 * Compatibility launcher for legacy PM2 deployments.
 *
 * Older server configs may still point at the repository-root `server.js`.
 * The real production entrypoint is `build/server.js`, so this file forwards
 * execution there after ensuring the compiled artifact is present.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const compiledServer = resolve(process.cwd(), 'build/server.js');

if (!existsSync(compiledServer)) {
  console.error('Missing build/server.js. Run `npm run build` before starting PM2.');
  process.exit(1);
}

await import(pathToFileURL(compiledServer).href);