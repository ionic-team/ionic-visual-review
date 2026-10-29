#!/usr/bin/env node
/*
 * Entry point for npm start and npm run export. Kept apart from index.mjs so tests can
 * import the server's pieces without starting it.
 *
 * - `export` as the first argument writes a static site instead of serving.
 * - Any startup failure, such as no clone found or no screenshots in the range,
 *   prints as one line and exits with code 1.
 */
import { exportSite } from './export.mjs';
import { main } from './index.mjs';

const run = process.argv[2] === 'export' ? () => exportSite(process.argv.slice(3)) : main;

run().catch((error) => {
  process.stderr.write(`\n  ${error.message}\n\n`);
  process.exit(1);
});
