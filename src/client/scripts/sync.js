/*
 * Writes to the server, and noticing a newer push.
 *
 * - Every viewed or comment change is saved through the server. A save that fails is
 *   dropped silently.
 * - When a viewed mark doesn't reach GitHub, the viewed count is marked out of sync,
 *   and its tooltip names the files GitHub refused or gives the error.
 * - A newer push shows a banner with Refresh. It is urgent when the push changed
 *   something just marked, naming the file if it was one, and quiet otherwise.
 * - Refresh rebuilds the review on the newer push and reloads. If that fails, the
 *   button says so and the current review stays.
 * - A static export has no server. Viewed marks are kept in this browser under the
 *   same rule the server applies: a mark survives only while its screenshot is
 *   unchanged. A newer push is noticed when head.json names another commit, and
 *   Refresh only reloads.
 */
import { fileOf } from './comments.js';
import { dom } from './dom.js';
import { entryFor } from './entries.js';
import { select } from './stage.js';
import { state } from './state.js';

/** @typedef {import('./state.js').Entry} Entry */

const VIEWED_KEY = 'snapshot-review-viewed';

/**
 * A static export's viewed marks, each with the blobs it was marked against.
 * @type {Record<string, { expectedSha: string | null, actualSha: string | null }>}
 */
let marks = {};

/** Writes the marks back. A browser that refuses storage keeps them for this visit only. */
const saveMarks = () => {
  try {
    localStorage.setItem(VIEWED_KEY, JSON.stringify(marks));
  } catch {
    /* Private mode, or storage blocked. */
  }
};

/**
 * Reads a static export's viewed marks from this browser, keeping each only while its
 * screenshot is unchanged, and drops the rest.
 * @param {Entry[]} entries
 * @returns {{ viewed: Record<string, true>, reset: number }} `reset` counts the marks a push undid.
 */
export const restoreViewed = (entries) => {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(VIEWED_KEY) ?? '{}') ?? {};
  } catch {
    stored = {};
  }

  const viewed = {};
  let reset = 0;
  marks = {};

  for (const entry of entries) {
    const record = stored[entry.path];
    if (!record) {
      continue;
    }

    if (record.expectedSha === entry.expectedSha && record.actualSha === entry.actualSha) {
      viewed[entry.path] = true;
      marks[entry.path] = record;
    } else {
      reset++;
    }
  }

  /* Rewritten from the survivors, so marks on screenshots that left the review do not
     accumulate. */
  saveMarks();
  return { viewed, reset };
};

/**
 * Saves a viewed or comment change, then reports a newer push or a failed GitHub sync
 * from the reply. A static export saves viewed marks in this browser instead.
 * @param {{ path?: string, paths?: string[], viewed?: boolean, comment?: string }} patch
 * @returns {Promise<void>}
 */
export const persist = (patch) => {
  if (state.static) {
    const paths = patch.paths ?? (patch.path ? [patch.path] : []);

    if (patch.viewed !== undefined) {
      for (const path of paths) {
        const entry = entryFor(path);
        if (patch.viewed && entry) {
          marks[path] = { expectedSha: entry.expectedSha, actualSha: entry.actualSha };
        } else {
          delete marks[path];
        }
      }
      saveMarks();
    }

    return checkHead(paths);
  }

  return fetch('/api/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
    .then((response) => response.json())
    .then((result) => {
      if (result?.freshness?.moved) {
        notePush(result.freshness);
      }
      /* A tick that did not reach GitHub has to say so, or the two tallies drift
         apart silently and the Files tab quietly disagrees. Named, because "some did
         not sync" is not something a reviewer can act on. */
      const mirrored = result?.mirrored;

      if (mirrored && !mirrored.ok) {
        const refused = mirrored.refused ?? [];
        dom.progressLabel.title = refused.length
          ? `GitHub would not accept ${refused.length} of these:\n${refused
              .map((path) => path.split('/').pop())
              .join('\n')}`
          : `Not synced to GitHub: ${mirrored.error}`;
        dom.progressLabel.classList.add('out-of-sync');
        if (refused.length) {
          console.warn('Not marked viewed on the pull request:', refused);
        }
      } else if (mirrored?.ok) {
        dom.progressLabel.title = '';
        dom.progressLabel.classList.remove('out-of-sync');
      }
    })
    .catch(() => {});
};

/**
 * Asks a static export whether a newer push has replaced it and shows the banner if
 * one has. Not throttled, since head.json is a few bytes. The full manifest is read
 * only once the head has moved, to tell which of `paths` the push changed.
 * @param {string[]} paths
 * @returns {Promise<void>}
 */
const checkHead = async (paths) => {
  try {
    const { head } = await fetch('head.json', { cache: 'no-store' }).then((response) => response.json());
    if (!head || head === state.head) {
      return;
    }

    const manifest = await fetch('manifest.json', { cache: 'no-store' }).then((response) => response.json());
    /* A path missing from the newer list is back to its baseline, so it changed too. */
    const latest = new Map(manifest.entries.map((entry) => [entry.path, entry.actualSha]));
    const changed = paths.filter((path) => latest.get(path) !== entryFor(path)?.actualSha);

    notePush({ head, changed });
  } catch {
    /* Offline, or mid-deploy. The next check will ask again. */
  }
};

/**
 * Asks whether a newer push has landed and shows the banner if it has. Called on load
 * and on tab focus, so a finished review still notices.
 * @returns {Promise<void>}
 */
export const checkFreshness = () =>
  state.static
    ? checkHead([])
    : fetch('/api/freshness')
        .then((response) => response.json())
        .then((result) => {
          if (result?.moved) {
            notePush(result);
          }
        })
        .catch(() => {});

/**
 * Shows the push banner: urgent when the push changed something just marked, quiet
 * when it did not.
 * @param {{ head: string, changed?: string[] }} freshness
 */
const notePush = ({ head, changed = [] }) => {
  state.pushedHead = head;
  state.changedByPush = new Set([...state.changedByPush, ...changed]);

  dom.pushed.hidden = false;
  dom.pushed.classList.toggle('urgent', changed.length > 0);

  const message =
    changed.length === 1
      ? `${fileOf(changed[0])} changed in a newer push.`
      : changed.length > 1
        ? `${changed.length} of the screenshots you just marked changed in a newer push.`
        : `A newer push is available (${head.slice(0, 7)}). Nothing you have marked has changed.`;

  dom.pushed.replaceChildren(document.createTextNode(`${message} `), refreshButton());

  /* Repaint, so the warning lands on the screenshot currently open as well. */
  if (state.current) {
    select(state.current, { scroll: false });
  }
};

/**
 * A button that rebuilds the review on the newer push, then reloads.
 * @returns {HTMLButtonElement}
 */
const refreshButton = () => {
  const button = document.createElement('button');
  button.className = 'refresh';
  button.textContent = 'Refresh';

  button.addEventListener('click', async () => {
    /* The newer export is already deployed, so there is nothing to rebuild. */
    if (state.static) {
      window.location.reload();
      return;
    }

    button.disabled = true;
    button.textContent = 'Refreshing…';

    try {
      const result = await fetch('/api/refresh', { method: 'POST' }).then((response) => response.json());
      if (!result?.ok) {
        throw new Error('refresh failed');
      }
      window.location.reload();
    } catch {
      button.disabled = false;
      button.textContent = 'Refresh failed, try again';
    }
  });

  return button;
};
