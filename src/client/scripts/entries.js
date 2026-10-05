/*
 * Lookups over the screenshot list: by path, by directory and by browser set.
 *
 * - A browser set is one test's screenshot across browsers. Chrome stands for the set
 *   when present, otherwise the first one.
 * - Directory and set scopes hold only what the filters admit, so a screenshot the
 *   filters hide is never marked.
 * - The comparison views are skipped when one side is missing or no pixel changed.
 * - Encoding only means different bytes with identical pixels. A rename that kept the
 *   same bytes doesn't count.
 */
import { state } from './state.js';

/** @typedef {import('./state.js').Entry} Entry */

/**
 * The entry for a path.
 * @param {string} path
 * @returns {Entry | undefined}
 */
export const entryFor = (path) => state.entries.find((candidate) => candidate.path === path);

/**
 * Whether the comparison views have anything to show. A pure move or a re-encode has
 * two sides but not one changed pixel.
 * @param {Entry | undefined} entry
 * @returns {boolean}
 */
export const worthComparing = (entry) => Boolean(entry?.comparable) && entry.ratio !== 0;

/**
 * Whether only the encoding changed: different files, identical pixels. A rename that
 * kept the same bytes is not counted.
 * @param {Entry | undefined} entry
 * @returns {boolean}
 */
export const reencodedOnly = (entry) =>
  Boolean(entry?.comparable) && entry.ratio === 0 && entry.expectedSha !== entry.actualSha;

/** Indexes every entry by directory and by browser set. */
export const indexGroups = () => {
  state.groups = new Map();
  state.sets = new Map();

  for (const entry of state.entries) {
    if (!state.groups.has(entry.group)) {
      state.groups.set(entry.group, []);
    }
    state.groups.get(entry.group).push(entry);

    const key = setKeyOf(entry);
    if (!state.sets.has(key)) {
      state.sets.set(key, []);
    }
    state.sets.get(key).push(entry);
  }
};

/**
 * The key shared by one test's screenshots across browsers.
 * @param {Entry} entry
 * @returns {string}
 */
export const setKeyOf = (entry) => `${entry.dir}/${entry.stem}`;

/**
 * Every browser's screenshot of one test.
 * @param {string} key From `setKeyOf`.
 * @returns {Entry[]}
 */
const setEntries = (key) => state.sets.get(key) ?? [];

/**
 * The screenshots in a set that the filters admit, so a browser the filters hide is
 * never marked.
 * @param {string} key From `setKeyOf`.
 * @returns {Entry[]}
 */
export const setScope = (key) => setEntries(key).filter((entry) => state.inScope.has(entry.path));

/* Chrome is the browser the team actually reads, so it speaks for the set where it is
   present. */
const PRIMARY_BROWSER = 'Mobile Chrome';

/**
 * The screenshot that stands for a set: Chrome when present, since that is the browser
 * the team reads.
 * @template {Pick<Entry, 'browser'>} T
 * @param {T[]} entries
 * @returns {T}
 */
export const setLead = (entries) => entries.find((entry) => entry.browser === PRIMARY_BROWSER) ?? entries[0];

/**
 * Drops the Mobile prefix from a Playwright project name.
 * @param {string} browser
 * @returns {string}
 */
export const shortBrowser = (browser) => browser.replace(/^Mobile /, '');

/**
 * Every screenshot in a directory.
 * @param {string} group
 * @returns {Entry[]}
 */
const groupEntries = (group) => state.groups.get(group) ?? [];

/**
 * The screenshots in a directory that the filters admit, which is what its checkbox
 * acts on.
 * @param {string} group
 * @returns {Entry[]}
 */
export const groupScope = (group) => groupEntries(group).filter((entry) => state.inScope.has(entry.path));

/**
 * How many of these are marked viewed.
 * @param {Entry[]} entries
 * @returns {number}
 */
export const countViewed = (entries) =>
  entries.reduce((total, entry) => total + (state.viewed.has(entry.path) ? 1 : 0), 0);
