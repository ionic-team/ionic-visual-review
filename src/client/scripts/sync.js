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
 */
import { fileOf } from './comments.js';
import { dom } from './dom.js';
import { select } from './stage.js';
import { state } from './state.js';

/**
 * Saves a viewed or comment change, then reports a newer push or a failed GitHub sync
 * from the reply.
 * @param {{ path?: string, paths?: string[], viewed?: boolean, comment?: string }} patch
 * @returns {Promise<void>}
 */
export const persist = (patch) =>
  fetch('/api/state', {
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

/**
 * Asks whether a newer push has landed and shows the banner if it has. Called on load
 * and on tab focus, so a finished review still notices.
 * @returns {Promise<void>}
 */
export const checkFreshness = () =>
  fetch('/api/freshness')
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
