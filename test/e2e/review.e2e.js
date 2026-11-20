import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { FIXTURE, createFixtureRepo } from '../fixtures/repo.js';

const CLI = fileURLToPath(new URL('../../src/cli.mjs', import.meta.url));

const PR_URL = 'https://github.com/ionic-team/ionic-framework/pull/1';

/* One server for the file, so the tests share it and run in order. */
test.describe.configure({ mode: 'serial' });

let fixture;
let server;
let address;

test.beforeAll(async () => {
  fixture = createFixtureRepo();
  /* The fake gh comes first on PATH, so the review runs signed out and offline. */
  server = spawn(
    process.execPath,
    [CLI, '--repo', fixture.dir, '--base', 'main', '--head', 'feature', '--no-open', '--port', '4410'],
    {
      env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}` },
    }
  );

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
  await expect(page.locator('.notice')).toHaveText(
    'No pixel changed. Only the encoding differs, so there is nothing to see.'
  );
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

test('should open side by side and remember the chosen view', async ({ page }) => {
  await page.locator(`.row[data-path="${FIXTURE.modified}"]`).click();
  await expect(page.locator('#modes .active')).toHaveText('Side by side');

  await page.getByRole('button', { name: 'Onion skin' }).click();
  await page.reload();
  await page.locator(`.row[data-path="${FIXTURE.modified}"]`).click();
  await expect(page.locator('#modes .active')).toHaveText('Onion skin');
});

test('should mark a row viewed from its checkbox without opening it', async ({ page }) => {
  const first = page.locator('.row').first();
  const second = page.locator('.row').nth(1);
  await first.click();

  const saved = page.waitForResponse((response) => response.url().endsWith('/api/state'));
  await second.locator('.row-box').check();
  await saved;

  await expect(second).toHaveClass(/is-viewed/);
  await expect(first).toHaveClass(/selected/);

  /* The store writes after a short debounce, so give it time before reloading. */
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.locator('.row').nth(1).locator('.row-box')).toBeChecked();
});

test('should narrow to commented snapshots', async ({ page }) => {
  /* A range review has no comment box, so the checkbox waits for a saved comment. */
  await expect(page.getByLabel('Commented only')).toBeHidden();

  await page.request.post(`${address}/api/state`, { data: { path: FIXTURE.added, comment: 'Looks off' } });
  /* The store writes after a short debounce, so give it time before reloading. */
  await page.waitForTimeout(400);
  await page.reload();

  await page.getByLabel('Commented only').check();
  await expect(page.locator('.row')).toHaveCount(1);
  await expect(page.locator(`.row[data-path="${FIXTURE.added}"]`)).toBeVisible();
});

/**
 * Makes the page believe it is reviewing pull request #1 signed out: a manifest with a
 * pr and no viewer. The fixture can't open a real one offline, so the manifest is
 * rewritten instead.
 * @param {import('@playwright/test').Page} page
 */
const signOutOfPullRequest = async (page) => {
  await page.route('**/api/manifest', async (route) => {
    const manifest = await (await route.fetch()).json();
    manifest.pr = 1;
    manifest.viewer = null;
    manifest.range.url = PR_URL;
    manifest.state.comments = { [FIXTURE.modified]: 'Band is too tall' };
    await route.fulfill({ json: manifest });
  });
  await page.reload();
};

test('should copy a comment when signed out of a pull request', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await signOutOfPullRequest(page);

  await page.locator(`.row[data-path="${FIXTURE.modified}"]`).click();
  await expect(page.locator('#publish')).toBeHidden();

  await page.getByRole('button', { name: 'Copy' }).click();
  await expect(page.locator('#copyComment')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Band is too tall');
});

test('should link the open screenshot into the pull request Files tab', async ({ page }) => {
  await signOutOfPullRequest(page);

  await page.locator(`.row[data-path="${FIXTURE.added}"]`).click();

  const anchor = createHash('sha256').update(FIXTURE.added).digest('hex');
  await expect(page.locator('#crumbStem')).toHaveAttribute('href', `${PR_URL}/files#diff-${anchor}`);
});
