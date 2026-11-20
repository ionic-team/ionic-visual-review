/*
 * Links to images on this server and to the same files on GitHub.
 *
 * - GitHub links appear only for commits on origin. A branch that was never pushed
 *   gets plain captions and no test link.
 * - The test link opens the spec at the line that took the screenshot, or the whole
 *   spec when the line can't be found. It is hidden when the spec is gone.
 * - The screenshot's name links it in the pull request's Files tab, where a copied
 *   comment can be pasted. Without a pull request it is plain text.
 * - Image URLs carry the head commit, so after Refresh the browser never shows an
 *   image cached from the previous push.
 */
import { dom } from './dom.js';
import { state } from './state.js';

/** @typedef {import('./state.js').Entry} Entry */

/**
 * The file on github.com at the commit for `side`, when that commit has been pushed.
 * @param {'expected' | 'actual'} side
 * @param {string} path
 * @returns {string | null}
 */
const githubBlob = (side, path) => {
  const base = state.blobBase;
  const sha = base?.[side];
  return sha ? `https://github.com/${base.repo}/blob/${sha}/${path}` : null;
};

/**
 * Points the crumb at the spec that took the screenshot, on its line when that can be
 * placed, and hides it when the spec is gone.
 * @param {Entry} entry
 */
export const setTestLink = (entry) => {
  const href = entry.test ? githubBlob('actual', entry.test.path) : null;

  if (!href) {
    dom.crumbTest.hidden = true;
    return;
  }

  const file = entry.test.path.split('/').pop();
  dom.crumbTest.hidden = false;
  dom.crumbTest.href = entry.test.line ? `${href}#L${entry.test.line}` : href;
  dom.crumbTest.textContent = entry.test.line ? `${file}:${entry.test.line}` : file;
  dom.crumbTest.title = entry.test.line
    ? 'Open the line that took this screenshot'
    : 'Open the spec that took this screenshot. The exact line could not be placed.';
};

/**
 * The hex SHA-256 of a path, which is how GitHub anchors a file in a pull request's
 * Files tab.
 * @param {string} path
 * @returns {Promise<string>}
 */
const diffAnchor = async (path) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * Links the screenshot's name to it in the pull request's Files tab, so a copied
 * comment can be pasted on it. Plain text when there is no pull request.
 * @param {Entry} entry
 * @returns {Promise<void>}
 */
export const setPrLink = async (entry) => {
  /* Cleared first, so the name never points at the previous screenshot while the
     hash for this one is worked out. */
  dom.crumbStem.removeAttribute('href');
  dom.crumbStem.title = '';

  if (!state.prUrl) {
    return;
  }

  const anchor = await diffAnchor(entry.path);

  /* Hashing is async, so a quick step through the list can finish out of order. */
  if (state.current !== entry.path) {
    return;
  }

  dom.crumbStem.href = `${state.prUrl}/files#diff-${anchor}`;
  dom.crumbStem.title = `Open this screenshot in #${state.pr}'s Files tab`;
};

const CAPTION = { M: ['Expected', 'Actual'], R: ['Expected', 'Actual'], A: [null, 'Added'], D: ['Removed', null] };

/**
 * Sets a caption to Expected, Actual, Added or Removed, linked to that version on GitHub
 * when there is one.
 * @param {HTMLElement} label
 * @param {'expected' | 'actual'} side
 * @param {string | null} path Null when this side does not exist.
 * @param {Entry['status']} status
 */
export const setCaptionLink = (label, side, path, status) => {
  const href = path ? githubBlob(side, path) : null;
  const [expected, actual] = CAPTION[status] ?? CAPTION.M;
  const text = (side === 'expected' ? expected : actual) ?? '';

  if (!href) {
    label.replaceChildren(document.createTextNode(text));
    return;
  }

  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = text;
  link.title = `Open this version on GitHub`;
  label.replaceChildren(link);
};

/**
 * This server's URL for one side of a screenshot. The commit is in the query, so a
 * refresh never serves an image cached from the previous push.
 * @param {'expected' | 'actual' | 'diff'} side
 * @param {string} path
 * @returns {string}
 */
export const blobUrl = (side, path) => `/blob?side=${side}&path=${encodeURIComponent(path)}&v=${state.head ?? ''}`;
