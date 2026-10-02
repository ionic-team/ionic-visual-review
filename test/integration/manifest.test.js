import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';

import { attachTests, buildManifest } from '../../src/git.mjs';
import { createStore } from '../../src/index.mjs';
import { BADGE_SPEC, FIXTURE, createFixtureRepo } from '../fixtures/repo.js';

/* The store writes after a short debounce; this waits it out. */
const FLUSH = 300;

describe('manifest: changed snapshots', () => {
  let fixture;
  let entries;
  const byPath = (path) => entries.find((entry) => entry.path === path);

  before(async () => {
    fixture = createFixtureRepo();
    ({ entries } = await buildManifest({ base: 'main', head: 'feature', cwd: fixture.dir }));
    await attachTests({ entries, ref: 'feature', cwd: fixture.dir });
  });

  after(() => fixture.cleanup());

  test('should list every changed snapshot with its status', () => {
    assert.deepEqual(
      Object.fromEntries(entries.map((entry) => [entry.path, entry.status])),
      {
        [FIXTURE.modified]: 'M',
        [FIXTURE.added]: 'A',
        [FIXTURE.removed]: 'D',
        [FIXTURE.renamedTo]: 'R',
        [FIXTURE.reencoded]: 'M',
        [FIXTURE.orphan]: 'M',
      }
    );
  });

  test('should record where a renamed snapshot came from', () => {
    const renamed = byPath(FIXTURE.renamedTo);
    assert.equal(renamed.oldPath, FIXTURE.renamedFrom);
    assert.equal(renamed.similarity, 100);
    assert.equal(renamed.expectedSha, renamed.actualSha);
  });

  test('should trace each snapshot to the line that took it', () => {
    const lines = BADGE_SPEC.split('\n');
    const lineOf = (needle) => lines.findIndex((line) => line.includes(needle)) + 1;

    assert.deepEqual(byPath(FIXTURE.modified).test, { path: FIXTURE.badgeSpec, line: lineOf('`badge-basic`') });
    assert.deepEqual(byPath(FIXTURE.added).test, { path: FIXTURE.badgeSpec, line: lineOf('-round`') });
  });

  test('should flag a snapshot whose spec is gone, but not one being deleted', () => {
    assert.equal(byPath(FIXTURE.orphan).orphaned, true);
    assert.equal(byPath(FIXTURE.orphan).test, null);
    assert.equal(byPath(FIXTURE.removed).orphaned, false);
  });
});

describe('store: viewed marks', () => {
  let fixture;
  let entries;

  before(async () => {
    fixture = createFixtureRepo();
    ({ entries } = await buildManifest({ base: 'main', head: 'feature', cwd: fixture.dir }));
  });

  after(() => fixture.cleanup());

  test('should keep a mark only while its snapshot is unchanged', async () => {
    const store = await createStore(fixture.dir, 'pr-1', entries);
    store.update({ paths: [FIXTURE.modified, FIXTURE.added], viewed: true });
    await wait(FLUSH);

    /* A later push rewrites one of the two marked snapshots. */
    const pushed = entries.map((entry) =>
      entry.path === FIXTURE.added ? { ...entry, actualSha: 'f'.repeat(40) } : entry
    );
    const reopened = await createStore(fixture.dir, 'pr-1', pushed);

    assert.deepEqual(reopened.summary, { carried: 1, reset: 1 });
    assert.deepEqual(Object.keys(reopened.read().viewed), [FIXTURE.modified]);
  });

  test('should report only the paths a mark actually flipped', async () => {
    const store = await createStore(fixture.dir, 'pr-2', entries);
    store.update({ paths: [FIXTURE.modified], viewed: true });

    const { flipped } = store.update({ paths: [FIXTURE.modified, FIXTURE.added], viewed: true });
    assert.deepEqual(flipped, [FIXTURE.added]);
    await wait(FLUSH);
  });
});
