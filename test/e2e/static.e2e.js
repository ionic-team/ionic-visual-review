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
  await exportSite([
    '--repo',
    fixture.dir,
    '--base',
    'main',
    '--head',
    'feature',
    '--out',
    out,
    '--url',
    'https://github.com/ionic-team/ionic-framework/pull/1',
  ]);

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

/**
 * A review comment as GitHub's REST API returns it, trimmed to what the page reads.
 * @param {{ id: number, replyTo?: number, commit: string, author: string, body: string }} comment
 */
const restComment = ({ id, replyTo, commit, author, body }) => ({
  id,
  in_reply_to_id: replyTo ?? null,
  path: FIXTURE.modified,
  commit_id: commit,
  user: { login: author },
  body_html: `<p>${body}</p>`,
  html_url: `https://github.com/ionic-team/ionic-framework/pull/1#discussion_r${id}`,
  created_at: '2026-10-28T00:00:00Z',
});

test.beforeEach(async ({ page }) => {
  /* The page reads comments from GitHub itself. No pull request has any unless a test
     says so, and none of these requests leaves the machine. */
  await page.route('https://api.github.com/**', (route) => route.fulfill({ json: [] }));
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

test('should show the pull request comments without a comment box', async ({ page }) => {
  const { head } = JSON.parse(readFileSync(join(out, 'head.json'), 'utf8'));
  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({
      json: [
        restComment({ id: 1, commit: head, author: 'teammate', body: 'Is the band meant to be green?' }),
        restComment({ id: 2, replyTo: 1, commit: head, author: 'author', body: 'Yes.' }),
        restComment({ id: 3, commit: 'a'.repeat(40), author: 'teammate', body: 'On an earlier push.' }),
      ],
    })
  );
  await page.reload();

  const row = page.locator(`.row[data-path="${FIXTURE.modified}"]`);
  await expect(row.locator('.note')).toHaveClass(/theirs/);
  await row.click();

  await expect(page.locator('#threads .thread-comment')).toHaveText([
    /teammate.*green/,
    /author.*Yes/,
    /teammate.*earlier/,
  ]);
  await expect(page.locator('#threads .thread-tag')).toHaveText(['outdated']);
  await expect(page.locator('#comment')).toBeHidden();
});

test('should say when GitHub refuses to send the comments', async ({ page }) => {
  await page.route('https://api.github.com/**', (route) => route.fulfill({ status: 403, json: {} }));
  await page.reload();

  await expect(page.locator('#threadsFailed')).toContainText('limiting requests');
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
