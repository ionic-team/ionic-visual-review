import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { exportSite } from '../../src/export.mjs';
import { FIXTURE, createFixtureRepo } from '../fixtures/repo.js';

describe('export: static site', () => {
  let fixture;
  let root;
  const range = () => ['--repo', fixture.dir, '--base', 'main', '--head', 'feature'];

  before(() => {
    fixture = createFixtureRepo();
    root = mkdtempSync(join(tmpdir(), 'visual-review-export-'));
  });

  after(() => {
    fixture.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  test('should write the page with every image the manifest points to', async () => {
    const out = join(root, 'site');
    await exportSite([...range(), '--out', out, '--label', '#1 badge']);

    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    const head = execFileSync('git', ['rev-parse', 'feature'], { cwd: fixture.dir }).toString().trim();

    assert.equal(manifest.static, true);
    assert.equal(manifest.head, head);
    assert.equal(manifest.range.label, '#1 badge');
    assert.equal(manifest.entries.length, 6);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'head.json'), 'utf8')), { head });

    for (const file of ['index.html', 'app.js', 'vendor/index.js', 'vendor/styles.css']) {
      assert.ok(existsSync(join(out, file)), file);
    }

    for (const entry of manifest.entries) {
      for (const sha of [entry.expectedSha, entry.actualSha].filter(Boolean)) {
        assert.ok(existsSync(join(out, 'images', `${sha}.png`)), `${entry.path} ${sha}`);
      }
      if (entry.comparable) {
        assert.ok(existsSync(join(out, 'diffs', `${entry.expectedSha}-${entry.actualSha}.png`)), entry.path);
      }
    }

    /* A rename is compared against its old path, which the image name already covers. */
    const renamed = manifest.entries.find((entry) => entry.path === FIXTURE.renamedTo);
    assert.equal(renamed.expectedSha, renamed.actualSha);
  });

  test('should refuse a folder that already has files in it', async () => {
    const out = join(root, 'taken');
    mkdirSync(out);
    writeFileSync(join(out, 'keep.txt'), 'mine');

    await assert.rejects(exportSite([...range(), '--out', out]), /already has files in it/);
    assert.equal(readFileSync(join(out, 'keep.txt'), 'utf8'), 'mine');
  });

  test('should write nothing when no screenshot changed', async () => {
    const out = join(root, 'empty');
    await exportSite(['--repo', fixture.dir, '--base', 'feature', '--head', 'feature', '--out', out]);

    assert.equal(existsSync(out), false);
  });
});
