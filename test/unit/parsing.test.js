import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { setLead } from '../../src/client/scripts/entries.js';
import { kb, percent } from '../../src/client/scripts/format.js';
import { indexScreenshotCalls, splitName } from '../../src/git.mjs';
import { BADGE_SPEC } from '../fixtures/repo.js';

describe('names: screenshot files', () => {
  test('should split browser, mode and direction from a plain name', () => {
    assert.deepEqual(splitName('badge-basic-md-ltr-Mobile-Chrome-linux.png'), {
      stem: 'badge-basic-md-ltr',
      browser: 'Mobile Chrome',
      mode: 'md',
      theme: 'md',
      direction: 'ltr',
      palette: 'light',
      name: 'badge-basic',
    });
  });

  test('should read the ionic theme apart from the mode it runs on', () => {
    const { theme, mode, palette, name } = splitName('badge-hint-ionic-md-ltr-light-Mobile-Safari-linux.png');
    assert.deepEqual(
      { theme, mode, palette, name },
      { theme: 'ionic', mode: 'md', palette: 'light', name: 'badge-hint' }
    );
  });

  test('should match the longest palette when a shorter one is its suffix', () => {
    assert.equal(splitName('toggle-ios-rtl-high-contrast-dark-Mobile-Firefox-linux.png').palette, 'high-contrast-dark');
  });

  test('should leave the axes empty for a name that does not follow the convention', () => {
    const { browser, mode, direction } = splitName('hand-made.png');
    assert.deepEqual({ browser, mode, direction }, { browser: null, mode: null, direction: null });
  });
});

describe('names: tracing to the spec', () => {
  test('should place a literal name and a templated one on their own lines', () => {
    const calls = indexScreenshotCalls(BADGE_SPEC);
    const literal = calls.find((call) => call.raw === 'badge-basic');
    const templated = calls.find((call) => call.pattern?.test('badge-solid-round'));

    assert.equal(BADGE_SPEC.split('\n')[literal.line - 1].includes('`badge-basic`'), true);
    assert.equal(BADGE_SPEC.split('\n')[templated.line - 1].includes('-round`'), true);
  });
});

describe('format: figures', () => {
  test('should keep no change and almost no change apart', () => {
    assert.equal(percent(0), '0%');
    assert.equal(percent(0.00001), '<0.01%');
    assert.equal(percent(0.0781), '7.81%');
    assert.equal(percent(null), '');
  });

  test('should show sizes in kilobytes', () => {
    assert.equal(kb(1536), '1.5 KB');
    assert.equal(kb(null), '');
  });
});

describe('entries: browser sets', () => {
  test('should let Chrome stand for a set when it is present', () => {
    const set = [{ browser: 'Mobile Firefox' }, { browser: 'Mobile Chrome' }, { browser: 'Mobile Safari' }];
    assert.equal(setLead(set).browser, 'Mobile Chrome');
  });

  test('should fall back to the first browser when Chrome is filtered out', () => {
    assert.equal(setLead([{ browser: 'Mobile Safari' }, { browser: 'Mobile Firefox' }]).browser, 'Mobile Safari');
  });
});
