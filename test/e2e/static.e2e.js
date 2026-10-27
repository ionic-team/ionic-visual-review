import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sirv from 'sirv';

import { exportSite } from '../../src/export.mjs';
import { FIXTURE, createFixtureRepo } from '../fixtures/repo.js';

/* One export for the file, served as plain files the way a static host would. */
test.describe.configure({ mode: 'serial' });

let fixture;
let root;
let out;
let server;
let address;

test.beforeAll(async () => {
  fixture = createFixtureRepo();
  root = mkdtempSync(join(tmpdir(), 'visual-review-static-'));
  out = join(root, 'site');
  await exportSite(['--repo', fixture.dir, '--base', 'main', '--head', 'feature', '--out', out]);

  const serve = sirv(out, { dev: true });
  server = createServer((req, res) =>
    serve(req, res, () => {
      res.writeHead(404).end();
    })
  );
  await new Promise((resolve) => server.listen(4411, '127.0.0.1', resolve));
  address = 'http://127.0.0.1:4411';
});

test.afterAll(() => {
  server?.close();
  fixture?.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await page.goto(address);
  await expect(page.locator('.row').first()).toBeVisible();
});

test('should list every changed snapshot without a comment box', async ({ page }) => {
  await expect(page.locator('.row')).toHaveCount(6);
  await expect(page.locator('#commentSection')).toBeHidden();
});

test('should load both sides and the diff of a modified snapshot', async ({ page }) => {
  await page.locator(`.row[data-path="${FIXTURE.modified}"]`).click();

  await expect(page.locator('#sxsExpected')).toHaveJSProperty('naturalWidth', 40);
  await expect(page.locator('#sxsActual')).toHaveJSProperty('naturalWidth', 40);
  await expect(page.locator('#diffImage')).toHaveJSProperty('naturalWidth', 40);
});

test('should keep a viewed mark in the browser across a reload', async ({ page }) => {
  await page.locator('.row').first().click();
  await page.keyboard.press('v');
  await expect(page.locator('#progressLabel')).toHaveText('1 / 6 viewed');

  await page.reload();
  await expect(page.locator('#progressLabel')).toHaveText('1 / 6 viewed');
});

test('should say a newer push changed the snapshot just marked', async ({ page }) => {
  /* What a deploy of the next push looks like from here: a new head, and the modified
     snapshot rewritten. */
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  for (const entry of manifest.entries) {
    if (entry.path === FIXTURE.modified) {
      entry.actualSha = 'f'.repeat(40);
    }
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(out, 'head.json'), JSON.stringify({ head: 'e'.repeat(40) }));

  await page.locator(`.row[data-path="${FIXTURE.modified}"]`).click();
  await page.keyboard.press('v');

  await expect(page.locator('#pushed')).toContainText('changed in a newer push');
  await expect(page.locator('#pushed')).toHaveClass(/urgent/);
});
