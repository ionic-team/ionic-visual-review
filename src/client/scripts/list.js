/*
 * The screenshot list, its directory headers and the viewed count in the top bar.
 *
 * - Each row shows status, name, browser, change, a viewed tick and a comment marker.
 *   The marker looks different when only a teammate commented.
 * - A grouped row speaks for its whole set: partly viewed when some browsers are, the
 *   largest change of any, and the missing-test warning if any member has no test.
 * - A directory header's checkbox and count cover what the filters admit, and its
 *   tooltip says how many it will mark.
 * - When nothing matches the filters, the list says so.
 */
import { STATUS_LABEL, dom } from './dom.js';
import { countViewed, entryFor, groupScope, setKeyOf, setScope, shortBrowser } from './entries.js';
import { percent } from './format.js';
import { state } from './state.js';

/** @typedef {import('./state.js').Entry} Entry */

/**
 * A row's label: the stem without the component name its directory already shows.
 * @param {Entry} entry
 * @returns {string}
 */
const rowLabel = (entry) => {
  const prefix = `${entry.group.split('/')[0]}-`;
  return entry.stem.startsWith(prefix) ? entry.stem.slice(prefix.length) : entry.stem;
};

/**
 * Draws a row's status, label, browser, change and flags. A grouped row describes its
 * whole set.
 * @param {HTMLElement} row
 * @param {Entry} entry The screenshot the row shows.
 */
const paintRow = (row, entry) => {
  /* A grouped row answers for every browser behind it, so its tick, its comment
     marker and its change figure all have to describe the set, not just the lead. */
  const kin = row.dataset.set ? setScope(row.dataset.set) : [entry];
  const seen = countViewed(kin);

  row.classList.toggle('selected', entry.path === state.current);
  row.classList.toggle('is-viewed', seen === kin.length);
  row.classList.toggle('is-part', seen > 0 && seen < kin.length);

  /* Both slots are always emitted and hidden when empty, so a tick keeps the same
     column whether or not the row also carries a comment. */
  /* One marker for any note on this screenshot, mine or a teammate's, since what a
     reviewer wants to spot in the list is that something was said about it. */
  const mine = kin.some((member) => state.comments.get(member.path));
  const theirs = kin.some((member) => (state.threads[member.path] ?? []).length > 0);

  const tickTitle =
    kin.length === 1
      ? 'Viewed'
      : seen === kin.length
        ? `Viewed in all ${kin.length}`
        : `Viewed in ${seen} of ${kin.length}`;

  const flags = [
    `<span class="tick${seen ? '' : ' off'}" title="${tickTitle}">✓</span>`,
    `<span class="note${mine || theirs ? '' : ' off'}${theirs && !mine ? ' theirs' : ''}" title="${
      mine && theirs ? 'You and others commented' : mine ? 'Has your comment' : 'Commented on the pull request'
    }"></span>`,
  ].join('');

  const ratios = kin.map((member) => member.ratio).filter((ratio) => ratio !== null && ratio !== undefined);
  const ratio = ratios.length ? Math.max(...ratios) : null;
  const change =
    ratio === null ? '<span class="row-change"></span>' : `<span class="row-change">${percent(ratio)}</span>`;

  /* Grouped, any browser missing its test makes the whole row worth flagging. */
  const orphaned = kin.some((member) => member.orphaned);

  row.innerHTML = `
    <span class="dot ${entry.status}" title="${STATUS_LABEL[entry.status] ?? ''}"></span>
    <span class="row-stem">${
      orphaned ? '<span class="warn" title="No test writes this screenshot"></span>' : ''
    }${rowLabel(entry)}</span>
    <span class="row-browser">${
      kin.length > 1
        ? `<span class="row-kin" title="${kin.map((member) => shortBrowser(member.browser)).join(', ')}">${kin.length}</span>`
        : entry.browser
          ? shortBrowser(entry.browser)
          : ''
    }</span>
    ${change}
    <span class="row-flags">${flags}</span>
  `;
};

/**
 * Repaints the row showing a screenshot, found through its set when grouped.
 * @param {string} path
 */
export const refreshRow = (path) => {
  /* Grouped, the screenshot that changed may not be the one its row is showing, so
     the row is found by the set it belongs to. */
  const member = entryFor(path);
  /** @type {HTMLElement | null} */
  const row =
    dom.list.querySelector(`.row[data-path="${CSS.escape(path)}"]`) ??
    (state.grouped && member ? dom.list.querySelector(`.row[data-set="${CSS.escape(setKeyOf(member))}"]`) : null);

  const entry = row && entryFor(row.dataset.path);
  if (row && entry) {
    paintRow(row, entry);
  }
};

/**
 * Updates a directory head's checkbox, count and tooltip for what the filters admit.
 * @param {HTMLElement} head
 * @param {string} group
 */
const paintGroupHead = (head, group) => {
  const entries = groupScope(group);
  const viewed = countViewed(entries);

  /** @type {HTMLInputElement} */
  const box = head.querySelector('.group-box');
  box.checked = viewed === entries.length;
  box.indeterminate = viewed > 0 && viewed < entries.length;

  head.classList.toggle('is-done', viewed === entries.length);
  head.querySelector('.group-count').textContent = `${viewed}/${entries.length}`;

  /* Counts what it will actually touch rather than claiming the whole directory: a
     filter narrows this, and a tooltip promising "every screenshot" would be wrong
     exactly when it matters. */
  const noun = entries.length === 1 ? 'screenshot' : 'screenshots';
  /** @type {HTMLElement} */ (head.querySelector('.group-check')).title =
    viewed === entries.length
      ? `Unmark ${entries.length} ${noun} listed here`
      : `Mark ${entries.length} ${noun} listed here viewed`;
};

/**
 * Creates a directory head.
 * @param {string} group
 * @returns {HTMLElement}
 */
const buildGroupHead = (group) => {
  const head = document.createElement('div');
  head.className = 'group-head';
  head.dataset.group = group;

  head.innerHTML = `
    <label class="group-check">
      <input class="group-box" type="checkbox" />
    </label>
    <b class="group-name">${group}</b>
    <span class="group-count mono"></span>
  `;

  paintGroupHead(head, group);
  return head;
};

/** Repaints every directory head. */
export const refreshGroupHeads = () => {
  for (const head of /** @type {NodeListOf<HTMLElement>} */ (dom.list.querySelectorAll('.group-head'))) {
    paintGroupHead(head, head.dataset.group);
  }
};

/**
 * Repaints one directory head, rather than walking all of them when a single
 * screenshot changed.
 * @param {string} group
 */
export const refreshGroupHead = (group) => {
  /** @type {HTMLElement | null} */
  const head = dom.list.querySelector(`.group-head[data-group="${CSS.escape(group)}"]`);
  if (head) {
    paintGroupHead(head, group);
  }
};

/** Rebuilds the list from the visible entries. */
export const renderList = () => {
  if (state.visible.length === 0) {
    dom.list.innerHTML = '<p class="empty">Nothing matches.</p>';
    return;
  }

  const fragment = document.createDocumentFragment();
  let group = null;

  for (const entry of state.visible) {
    if (entry.group !== group) {
      group = entry.group;
      fragment.append(buildGroupHead(group));
    }

    const row = document.createElement('button');
    row.className = 'row';
    row.dataset.path = entry.path;
    if (state.grouped) {
      row.dataset.set = setKeyOf(entry);
    }
    paintRow(row, entry);
    fragment.append(row);
  }

  dom.list.replaceChildren(fragment);
};

/** Updates the viewed count and progress bar in the top bar. */
export const renderProgress = () => {
  const total = state.entries.length;
  dom.progressLabel.textContent = `${state.viewed.size} / ${total} viewed`;
  dom.progressFill.style.width = total ? `${(state.viewed.size / total) * 100}%` : '0';
};
