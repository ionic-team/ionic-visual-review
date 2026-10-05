/*
 * Entry point for the page: wires the controls, loads the review and renders it.
 *
 * - The comment box, teammates' comments and the c shortcut appear only for a pull
 *   request with gh signed in. Viewed marks work in every case.
 * - If a push changed screenshots since they were marked viewed, the sidebar says how
 *   many lost their mark.
 * - The orphans only and encoding only checkboxes appear only when there is one.
 * - A newer push is checked for on load and whenever the tab regains focus.
 * - Every image is prefetched after the first render, so stepping through stays
 *   instant.
 */
import { renderPublish, wireComments } from './scripts/comments.js';
import { wireControls } from './scripts/controls.js';
import { dom } from './scripts/dom.js';
import { indexGroups, reencodedOnly } from './scripts/entries.js';
import { applyFilter, renderFacets, restoreGrouping } from './scripts/filters.js';
import { wireKeyboard } from './scripts/keyboard.js';
import { blobUrl } from './scripts/links.js';
import { renderList, renderProgress } from './scripts/list.js';
import { select } from './scripts/stage.js';
import { state } from './scripts/state.js';
import { checkFreshness } from './scripts/sync.js';
import { restoreTheme } from './scripts/theme.js';

/**
 * Restores the reviewer's preferences, loads the manifest and renders the first screen.
 * @returns {Promise<void>}
 */
const init = async () => {
  /* Before the manifest, so the first paint is already in the right theme. */
  restoreTheme();
  restoreGrouping();

  window.addEventListener('focus', checkFreshness);

  const manifest = await fetch('/api/manifest').then((response) => response.json());

  state.head = manifest.head ?? null;
  state.blobBase = manifest.blobBase ?? null;
  state.entries = manifest.entries;
  state.viewed = new Set(Object.keys(manifest.state.viewed ?? {}));
  state.comments = new Map(Object.entries(manifest.state.comments ?? {}));
  state.stale = new Set(manifest.state.stale ?? []);
  state.unsent = new Set(manifest.state.unsent ?? []);
  state.posted = new Set(manifest.state.posted ?? []);
  state.threads = manifest.threads ?? {};
  state.pr = manifest.pr ?? null;
  state.prState = manifest.prState ?? null;
  state.viewer = manifest.viewer ?? null;

  /* A comment exists to be posted on a pull request. Without one, or without an account
     to post as, there is nowhere for it to go, so the box would only collect notes that
     never leave this machine. Viewed stays either way: it is how a range is worked
     through, pull request or not. */
  dom.commentSection.hidden = !state.pr || !state.viewer;
  renderPublish();

  /* Only the screenshots that lost their tick are worth saying out loud. Carrying
     progress over is the expected outcome and needs no announcement; ticks vanishing
     without explanation does. */
  const { reset = 0 } = manifest.carriedOver ?? {};
  if (reset) {
    dom.carried.hidden = false;
    dom.carried.textContent = `${reset} ${
      reset === 1 ? 'screenshot has' : 'screenshots have'
    } changed since you reviewed ${reset === 1 ? 'it' : 'them'} and need another look.`;
  }
  indexGroups();

  dom.rangeLabel.textContent = manifest.range.label;
  if (manifest.range.url) {
    dom.rangeLabel.href = manifest.range.url;
  }
  dom.rangeRefs.textContent = manifest.range.mergeBase.slice(0, 10);
  dom.rangeRefs.title = 'Merge base: the commit every expected screenshot is read from';

  /* Offered only when there is something to find, the same way a filter with one value
     is left out of the facet bar. */
  dom.orphansOnlyLabel.hidden = !state.entries.some((entry) => entry.orphaned);
  dom.reencodedOnlyLabel.hidden = !state.entries.some(reencodedOnly);

  renderFacets();

  document.documentElement.style.setProperty('--onion', String(dom.onion.valueAsNumber / 100));

  applyFilter();
  renderList();
  renderProgress();

  if (state.visible[0] ?? state.entries[0]) {
    select((state.visible[0] ?? state.entries[0]).path);
  }

  /* Asked once the list is up, so a push that landed before this session opened is
     reported without waiting for the reviewer to mark something. */
  checkFreshness();

  /* Warm the cache so stepping through hundreds of screenshots stays instant. */
  const queue = state.entries
    .flatMap((entry) => [
      entry.status === 'A' ? null : blobUrl('expected', entry.path),
      entry.status === 'D' ? null : blobUrl('actual', entry.path),
      entry.comparable ? blobUrl('diff', entry.path) : null,
    ])
    .filter(Boolean);

  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (;;) {
        const url = queue.shift();
        if (!url) {
          return;
        }
        await fetch(url, { cache: 'force-cache' }).catch(() => {});
      }
    })
  );
};

wireComments();
wireControls();
wireKeyboard();
init();
