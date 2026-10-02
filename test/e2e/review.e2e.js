import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { createFixtureRepo } from '../fixtures/repo.js';

const CLI = fileURLToPath(new URL('../../src/cli.mjs', import.meta.url));

/* One server for the file, so the tests share it and run in order. */
test.describe.configure({ mode: 'serial' });

let fixture;
let server;
let address;

test.beforeAll(async () => {
  fixture = createFixtureRepo();
  /* The fake gh comes first on PATH, so the review runs signed out and offline. */
  server = spawn(process.execPath, [CLI, '--repo', fixture.dir, '--base', 'main', '--head', 'feature', '--no-open', '--port', '4410'], {
    env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}` },
  });

  address = await new Promise((resolve, reject) => {
    let output = '';
    server.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/localhost:\d+/);
      if (match) {
        resolve(match[0]);
      }
    });
    server.on('exit', (code) => reject(new Error(`server exited with ${code}: ${output}`)));
  });
});

test.afterAll(() => {
  server?.kill();
  fixture?.cleanup();
});

test.beforeEach(async ({ page }) => {
  await page.goto(address);
  await expect(page.locator('.row').first()).toBeVisible();
});

test('should list every changed snapshot under its directory', async ({ page }) => {
  await expect(page.locator('.row')).toHaveCount(6);
  await expect(page.locator('.group-head .group-name')).toHaveText(['badge/test/basic', 'chip/test/hint']);
});

test('should flag the snapshot whose spec was deleted', async ({ page }) => {
  await page.getByLabel('Missing test only').check();

  await expect(page.locator('.row')).toHaveCount(1);
  await page.locator('.row').click();
  await expect(page.locator('.orphan')).toHaveText('No test writes this screenshot');
});

test('should explain a snapshot whose encoding is the only change', async ({ page }) => {
  await page.getByLabel('Encoding differs only').check();

  await expect(page.locator('.row')).toHaveCount(1);
  await page.locator('.row').click();
  await expect(page.locator('.notice')).toHaveText('No pixel changed. Only the encoding differs, so there is nothing to see.');
});

test('should keep a viewed mark across a reload', async ({ page }) => {
  await page.locator('.row').first().click();
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/state'));
  await page.keyboard.press('v');
  await saved;
  await expect(page.locator('#progressLabel')).toHaveText('1 / 6 viewed');

  /* The store writes after a short debounce, so give it time before reloading. */
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.locator('#progressLabel')).toHaveText('1 / 6 viewed');
});
