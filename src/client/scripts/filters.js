/*
 * The facet rows, the checkbox filters and one row per test.
 *
 * - Each facet row (status, browser, mode, theme, direction, palette) is a filter.
 *   Values combine within a row, and a screenshot must match every row in use.
 * - A row with only one value is left out, except status. Theme is left out when it
 *   repeats mode, which is always the case on main.
 * - Text, facets, orphans only and encoding only decide what a directory covers.
 *   Unviewed only just hides rows, so directory counts stay whole.
 * - One row per test collapses each browser set to one row, led by Chrome, and is
 *   remembered in this browser.
 * - When the open screenshot is filtered out, the first visible one opens instead.
 */
import { BROWSER_ORDER, STATUS_COUNT_LABEL, dom } from './dom.js';
import { reencodedOnly, setKeyOf, setLead, shortBrowser } from './entries.js';
import { renderList } from './list.js';
import { select } from './stage.js';
import { state } from './state.js';

/**
 * The facets the list can be narrowed by. Values are listed rather than discovered, so a
 * facet knows which of its values a range is missing.
 */
const FACETS = [
  { key: 'status', values: ['M', 'A', 'D', 'R'], label: (value) => STATUS_COUNT_LABEL[value], always: true },
  { key: 'browser', values: BROWSER_ORDER, label: (value) => shortBrowser(value) },
  { key: 'mode', values: ['ios', 'md'], label: (value) => value },
  /* Mode is behaviour and theme is appearance, so the ionic theme runs on both modes.
     On main there is no ionic theme and the two axes always agree, which is what
     redundantWith suppresses. */
  { key: 'theme', values: ['ios', 'md', 'ionic'], label: (value) => value, redundantWith: 'mode' },
  { key: 'direction', values: ['ltr', 'rtl'], label: (value) => value },
  { key: 'palette', values: ['light', 'dark', 'high-contrast', 'high-contrast-dark'], label: (value) => value },
];

/**
 * Renders each facet as a row of counts that doubles as its filter. A facet with one
 * value, or one repeating another, is left out.
 */
export const renderFacets = () => {
  const tallies = new Map();

  for (const facet of FACETS) {
    const counts = new Map();
    for (const entry of state.entries) {
      const value = entry[facet.key];
      if (value !== null && value !== undefined) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    /* Sorted by what is shown, not by the raw value: status is stored as M, A, D and
       R but reads as added, modified, removed, renamed. */
    const present = facet.values
      .filter((value) => counts.has(value))
      .sort((a, b) => facet.label(a).localeCompare(facet.label(b)));

    tallies.set(facet.key, { counts, present });
  }

  const identical = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
  const rows = [];

  for (const facet of FACETS) {
    const { counts, present } = tallies.get(facet.key);

    /* One possible value is nothing to narrow, so the row is left out entirely. Most
       ranges are wholly ltr and wholly light, and those rows would never be usable. */
    if (present.length < 2 && !facet.always) {
      continue;
    }

    /* Two rows offering the same choice are worse than one. */
    if (facet.redundantWith && identical(present, tallies.get(facet.redundantWith).present)) {
      continue;
    }

    const selected = state.facets[facet.key];
    const row = document.createElement('div');
    row.className = 'facet';
    row.dataset.facet = facet.key;
    row.classList.toggle('filtering', selected.size > 0);

    /* Named, because mode and theme share their values and adjacent rows of bare
       "ios md" chips would be impossible to tell apart. */
    const name = document.createElement('span');
    name.className = 'facet-name';
    name.textContent = facet.key;
    row.append(name);

    const chips = document.createElement('span');
    chips.className = 'facet-chips';

    for (const value of present) {
      const button = document.createElement('button');
      button.className = 'count';
      button.dataset.value = value;
      button.classList.toggle('active', selected.has(value));
      button.innerHTML = `<b>${counts.get(value)}</b> ${facet.label(value)}`;
      button.title = selected.has(value)
        ? `Showing only ${facet.label(value)}. Click to stop filtering by it.`
        : `Show only ${facet.label(value)}`;
      chips.append(button);
    }

    row.append(chips);
    rows.push(row);
  }

  dom.facets.replaceChildren(...rows);
};

/**
 * Works out which entries the filters admit and which rows are visible, collapsing
 * browser sets when grouped. Unviewed only hides rows without narrowing a directory.
 */
export const applyFilter = () => {
  const needle = dom.filter.value.trim().toLowerCase();

  /* Content filters decide what a directory means. "Unviewed only" is deliberately
     not one of them: it hides rows by progress rather than by content, and folding it
     in here would make every directory read 0 out of however many are left. */
  state.inScope = new Set(
    state.entries
      .filter((entry) => {
        if (dom.orphansOnly.checked && !entry.orphaned) {
          return false;
        }

        if (dom.reencodedOnly.checked && !reencodedOnly(entry)) {
          return false;
        }

        for (const facet of FACETS) {
          const selected = state.facets[facet.key];
          if (selected.size && !selected.has(entry[facet.key])) {
            return false;
          }
        }
        return !needle || `${entry.group}/${entry.file}`.toLowerCase().includes(needle);
      })
      .map((entry) => entry.path)
  );

  state.visible = state.entries.filter(
    (entry) => state.inScope.has(entry.path) && !(dom.unviewedOnly.checked && state.viewed.has(entry.path))
  );

  /* Collapsed here rather than at render, so that stepping, selecting and jumping to
     the next unviewed all move between rows instead of through browsers the list is
     no longer showing. */
  if (state.grouped) {
    const members = new Map();
    for (const entry of state.visible) {
      const key = setKeyOf(entry);
      if (!members.has(key)) {
        members.set(key, []);
      }
      members.get(key).push(entry);
    }

    const seen = new Set();
    state.visible = state.visible.reduce((rows, entry) => {
      const key = setKeyOf(entry);
      if (!seen.has(key)) {
        seen.add(key);
        rows.push(setLead(members.get(key)));
      }
      return rows;
    }, []);
  }
};

export const GROUP_KEY = 'snapshot-review-group-browsers';

/** Applies the remembered One row per test setting. */
export const restoreGrouping = () => {
  let saved = null;
  try {
    saved = localStorage.getItem(GROUP_KEY);
  } catch {
    saved = null;
  }
  state.grouped = saved === 'on';
  dom.groupBrowsers.checked = state.grouped;
};

/** Reapplies the filters and redraws, moving the selection if it was filtered out. */
export const refilter = () => {
  applyFilter();
  renderList();
  if (state.visible.length && !state.visible.some((entry) => entry.path === state.current)) {
    select(state.visible[0].path);
  }
};
