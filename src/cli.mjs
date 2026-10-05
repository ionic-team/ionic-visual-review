#!/usr/bin/env node
/*
 * Entry point for npm start. Kept apart from index.mjs so tests can import the
 * server's pieces without starting it.
 *
 * - Any startup failure, such as no clone found or no screenshots in the range,
 *   prints as one line and exits with code 1.
 */
import { main } from './index.mjs';

main().catch((error) => {
  process.stderr.write(`\n  ${error.message}\n\n`);
  process.exit(1);
});
