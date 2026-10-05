/*
 * The one mutable state object every script reads and writes.
 *
 * - Filled from the manifest on load, and again after Refresh reloads the page.
 * - Nothing here is saved by itself. Viewed marks and comments persist through the
 *   server, and preferences through localStorage in their own scripts.
 */

/**
 * One screenshot in the review, as the server sends it.
 * @typedef {object} Entry
 * @property {string} path
 * @property {string} file
 * @property {string} dir
 * @property {string} group The directory as shown, such as "textarea/test/slot".
 * @property {string} stem The file name without browser, platform or extension.
 * @property {string | null} browser
 * @property {'A' | 'M' | 'D' | 'R'} status
 * @property {string | null} mode
 * @property {string | null} theme
 * @property {string | null} direction
 * @property {string | null} palette
 * @property {string | null} oldPath Where a renamed screenshot's baseline lives.
 * @property {string | null} oldGroup
 * @property {string | null} oldStem
 * @property {string | null} expectedSha
 * @property {string | null} actualSha
 * @property {boolean} comparable Both sides exist.
 * @property {number | null} ratio Changed pixels as a share of the canvas.
 * @property {number | null} changed Changed pixels.
 * @property {boolean} resized
 * @property {{ width: number, height: number } | null} size
 * @property {{ width: number, height: number } | null} expectedSize
 * @property {{ width: number, height: number } | null} actualSize
 * @property {{ expected: number | null, actual: number | null }} bytes
 * @property {{ path: string, line: number | null } | null} test The spec that took it.
 * @property {boolean} orphaned Still in the range, but no spec writes it.
 */

export const state = {
  entries: [],
  visible: [],
  viewed: new Set(),
  comments: new Map(),
  /* Comments written against a version of the screenshot that has since changed. */
  stale: new Set(),
  /* Screenshots a push has rewritten since this server started. */
  changedByPush: new Set(),
  pushedHead: null,
  /* Review threads already on the pull request, keyed by path. */
  threads: {},
  /* Comments not yet on the pull request, and the pull request to post them to. */
  unsent: new Set(),
  /* Comments that are on the pull request right now. */
  posted: new Set(),
  pr: null,
  /* OPEN, CLOSED or MERGED. Only an open pull request takes new comments. */
  prState: null,
  /* The GitHub account gh is logged in as, or null when it has none. */
  viewer: null,
  /* Every screenshot in a directory, keyed by directory. */
  groups: new Map(),
  /* The same screenshot across browsers, keyed by directory and name. */
  sets: new Map(),
  /* Whether the list shows one row per test rather than one per browser. */
  grouped: false,
  /* The paths the content filters currently admit, which is what a directory means
     while a filter is on. */
  inScope: new Set(),
  /* Per facet, the values the list is restricted to. An empty set means no
     restriction on that facet. */
  facets: {
    status: new Set(),
    browser: new Set(),
    mode: new Set(),
    theme: new Set(),
    direction: new Set(),
    palette: new Set(),
  },
  current: null,
  /* The commit this page is showing, used to version image URLs. */
  head: null,
  /* Repo and the two commits, when they are pushed and can be linked to. */
  blobBase: null,
  mode: 'slider',
  zoom: 'fit',
};
