#!/usr/bin/env node

/**
 * Compatibility launcher for legacy worker entrypoints.
 *
 * This keeps old Docker/PM2 references to root-level `worker.js` working
 * while the real runtime stays in `build/worker.js`.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const compiledWorker = resolve(process.cwd(), 'build/worker.js');

if (!existsSync(compiledWorker)) {
  console.error('Missing build/worker.js. Run `npm run build` before starting the worker.');
  process.exit(1);
}

await import(pathToFileURL(compiledWorker).href);