/* A throwaway ionic-framework lookalike with one of every kind of snapshot change. */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';

const BADGE = 'core/src/components/badge/test/basic';
const CHIP = 'core/src/components/chip/test/hint';
const SNAPSHOTS = `${BADGE}/badge.e2e.ts-snapshots`;

/** Paths of the snapshots the fixture changes, by what happens to each. */
export const FIXTURE = {
  modified: `${SNAPSHOTS}/badge-basic-md-ltr-Mobile-Chrome-linux.png`,
  added: `${SNAPSHOTS}/badge-solid-round-md-ltr-Mobile-Chrome-linux.png`,
  removed: `${SNAPSHOTS}/badge-old-md-ltr-Mobile-Chrome-linux.png`,
  renamedFrom: `${SNAPSHOTS}/badge-moved-md-ltr-Mobile-Chrome-linux.png`,
  renamedTo: `${SNAPSHOTS}/badge-renamed-md-ltr-Mobile-Chrome-linux.png`,
  reencoded: `${SNAPSHOTS}/badge-basic-ios-ltr-Mobile-Chrome-linux.png`,
  orphan: `${CHIP}/chip.e2e.ts-snapshots/chip-hint-md-ltr-Mobile-Chrome-linux.png`,
  badgeSpec: `${BADGE}/badge.e2e.ts`,
};

/** The badge spec. One literal screenshot name and one built from a template. */
export const BADGE_SPEC = `import { expect } from '@playwright/test';
import { configs, test } from '@utils/test/playwright';

configs().forEach(({ title, screenshot }) => {
  test.describe(title('badge: basic'), () => {
    test('should not have visual regressions', async ({ page }) => {
      await expect(page).toHaveScreenshot(screenshot(\`badge-basic\`));
    });

    test('should render each variant', async ({ page }) => {
      await expect(page).toHaveScreenshot(screenshot(\`badge-\${variant}-round\`));
    });
  });
});
`;

/**
 * Encodes a solid PNG, optionally with a band of a second colour.
 * @param {[number, number, number]} rgb
 * @param {{ band?: [number, number, number], deflateLevel?: number }} [options]
 * @returns {Buffer}
 */
export const png = (rgb, { band, deflateLevel = 9 } = {}) => {
  const image = new PNG({ width: 40, height: 20 });
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const colour = band && y < 5 ? band : rgb;
      const i = (image.width * y + x) << 2;
      image.data.set([...colour, 255], i);
    }
  }
  return PNG.sync.write(image, { deflateLevel });
};

/**
 * Creates the fixture repository: `main` as the base and `feature` as the head.
 * @returns {{ dir: string, bin: string, cleanup: () => void }} `bin` holds a fake gh that
 * always fails, so nothing can reach GitHub.
 */
export const createFixtureRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'visual-review-'));
  const dir = join(root, 'repo');
  const bin = join(root, 'bin');

  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], {
      cwd: dir,
      stdio: 'pipe',
    });
  const write = (path, contents) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), contents);
  };
  const remove = (path) => rmSync(join(dir, path));

  mkdirSync(dir, { recursive: true });
  git('init', '-q', '-b', 'main');

  write(FIXTURE.badgeSpec, BADGE_SPEC);
  write(FIXTURE.modified, png([220, 40, 40]));
  write(`${SNAPSHOTS}/badge-basic-md-ltr-Mobile-Firefox-linux.png`, png([220, 40, 40]));
  write(FIXTURE.reencoded, png([40, 80, 220]));
  write(FIXTURE.removed, png([90, 90, 90]));
  write(FIXTURE.renamedFrom, png([200, 160, 20]));
  write(`${CHIP}/chip.e2e.ts`, "await expect(page).toHaveScreenshot(screenshot('chip-hint'));\n");
  write(FIXTURE.orphan, png([20, 160, 90]));
  git('add', '-A');
  git('commit', '-q', '-m', 'base');

  git('checkout', '-q', '-b', 'feature');
  write(FIXTURE.modified, png([220, 40, 40], { band: [40, 200, 40] }));
  write(FIXTURE.added, png([120, 40, 200]));
  write(FIXTURE.reencoded, png([40, 80, 220], { deflateLevel: 0 }));
  remove(FIXTURE.removed);
  git('mv', FIXTURE.renamedFrom, FIXTURE.renamedTo);
  remove(`${CHIP}/chip.e2e.ts`);
  write(FIXTURE.orphan, png([20, 160, 90], { band: [240, 240, 240] }));
  git('add', '-A');
  git('commit', '-q', '-m', 'feature');

  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'gh'), 0o755);

  return { dir, bin, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};
