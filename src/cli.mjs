#!/usr/bin/env node
/* Entry point. Kept apart from index.mjs so tests can import the server's pieces
   without starting it. */
import { main } from './index.mjs';

main().catch((error) => {
  process.stderr.write(`\n  ${error.message}\n\n`);
  process.exit(1);
});
