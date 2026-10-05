/*
 * Moving through the list and marking screenshots viewed.
 *
 * - j and k stop at either end. n wraps round to the top.
 * - Marking a grouped row marks every browser in its set that the filters admit.
 * - With unviewed only on, a marked row disappears and the selection moves to the
 *   row that took its place.
 * - A directory checkbox, or Shift+V, marks the whole directory in one write.
 * - Marks show immediately. Saving them, and syncing them to GitHub, happens in
 *   sync.js and on the server.
 */
import { dom } from './dom.js';
import { entryFor, groupScope, setKeyOf, setScope } from './entries.js';
import { applyFilter } from './filters.js';
import { refreshGroupHead, refreshGroupHeads, refreshRow, renderList, renderProgress } from './list.js';
import { select } from './stage.js';
import { state } from './state.js';
import { persist } from './sync.js';

/**
 * Where the selection is among the visible rows.
 * @returns {number} -1 when nothing visible is selected.
 */
const visibleIndex = () => state.visible.findIndex((entry) => entry.path === state.current);

/**
 * Moves the selection by `delta` rows, stopping at either end.
 * @param {number} delta
 */
export const step = (delta) => {
  if (!state.visible.length) {
    return;
  }
  const index = visibleIndex();
  const next = index === -1 ? 0 : Math.min(state.visible.length - 1, Math.max(0, index + delta));
  select(state.visible[next].path);
};

/** Selects the next unviewed row, wrapping round to the top. */
export const nextUnviewed = () => {
  const index = visibleIndex();
  const ordered = [...state.visible.slice(index + 1), ...state.visible.slice(0, Math.max(index, 0))];
  const target = ordered.find((entry) => !state.viewed.has(entry.path));
  if (target) {
    select(target.path);
  }
};

/**
 * Marks the selected screenshot viewed or not, and its whole set when grouped.
 * @param {boolean} value
 * @param {{ advance?: boolean }} [options] `advance` moves to the next row afterwards.
 */
export const setViewed = (value, { advance = false } = {}) => {
  const path = state.current;
  if (!path) {
    return;
  }

  const index = visibleIndex();
  const entry = entryFor(path);

  /* Grouped, the row stands for every browser behind it, so judging the one on screen
     judges the set. */
  const targets = state.grouped && entry ? setScope(setKeyOf(entry)).map((member) => member.path) : [path];

  for (const target of targets) {
    if (value) {
      state.viewed.add(target);
    } else {
      state.viewed.delete(target);
    }
  }
  persist({ paths: targets, viewed: value });
  dom.viewed.checked = value;
  renderProgress();

  const hidden = dom.unviewedOnly.checked && value;
  if (hidden) {
    applyFilter();
    renderList();
  } else {
    refreshRow(path);
    /* The directory header carries its own tally, so marking one screenshot has to
       move it too, or the header disagrees with the rows beneath it. */
    if (entry) {
      refreshGroupHead(entry.group);
    }
  }

  if (advance) {
    if (hidden) {
      const target = state.visible[Math.min(index, state.visible.length - 1)];
      if (target) {
        select(target.path);
      }
    } else {
      step(1);
    }
  }
};

/**
 * Marks many screenshots in a single write.
 * @param {string[]} paths
 * @param {boolean} value
 */
const setViewedMany = (paths, value) => {
  if (paths.length === 0) {
    return;
  }

  for (const path of paths) {
    if (value) {
      state.viewed.add(path);
    } else {
      state.viewed.delete(path);
    }
  }
  persist({ paths, viewed: value });
  renderProgress();

  if (state.current && paths.includes(state.current)) {
    dom.viewed.checked = value;
  }

  /* Marking viewed removes rows while that filter is on, so the list has to be rebuilt
     rather than repainted in place. */
  if (dom.unviewedOnly.checked) {
    const anchor = state.current;
    applyFilter();
    renderList();
    if (anchor && state.visible.some((entry) => entry.path === anchor)) {
      select(anchor);
    } else if (state.visible.length) {
      select(state.visible[0].path);
    }
    return;
  }

  for (const path of paths) {
    refreshRow(path);
  }
  refreshGroupHeads();
};

/**
 * Marks the screenshots a directory's checkbox covers.
 * @param {string} group
 * @param {boolean} value
 */
export const toggleGroup = (group, value) =>
  setViewedMany(
    groupScope(group).map((entry) => entry.path),
    value
  );
