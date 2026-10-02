/* Event wiring for the toolbar, list, filters and dialogs. */
import { deleteCurrentComment, publishComments } from './comments.js';
import { dom } from './dom.js';
import { entryFor, setKeyOf } from './entries.js';
import { GROUP_KEY, applyFilter, refilter, renderFacets } from './filters.js';
import { renderList } from './list.js';
import { setViewed, toggleGroup } from './navigation.js';
import { applyMode, applyZoom, select } from './stage.js';
import { state } from './state.js';
import { applyTheme } from './theme.js';

/**
 * Connects the toolbar, list, filters, checkboxes, theme picker and help dialog to their
 * handlers.
 */
export const wireControls = () => {
  dom.modes.addEventListener('click', (event) => {
    const mode = event.target.dataset?.mode;
    if (mode && !event.target.disabled) {
      state.mode = mode;
      applyMode();
      applyZoom();
    }
  });

  dom.zoom.addEventListener('click', (event) => {
    const zoom = event.target.dataset?.zoom;
    if (zoom) {
      state.zoom = zoom;
      applyZoom();
    }
  });

  dom.onion.addEventListener('input', () =>
    document.documentElement.style.setProperty('--onion', dom.onion.value / 100)
  );

  dom.list.addEventListener('click', (event) => {
    const row = event.target.closest('.row');
    if (row) {
      select(row.dataset.path, { scroll: false });
    }
  });

  dom.list.addEventListener('change', (event) => {
    if (event.target.classList.contains('group-box')) {
      toggleGroup(event.target.closest('.group-head').dataset.group, event.target.checked);
    }
  });

  dom.viewed.addEventListener('change', () => setViewed(dom.viewed.checked));

  dom.groupBrowsers.addEventListener('change', () => {
    state.grouped = dom.groupBrowsers.checked;
    try {
      localStorage.setItem(GROUP_KEY, state.grouped ? 'on' : 'off');
    } catch {
      /* A browser refusing storage is not a reason to refuse the setting. */
    }

    const anchor = entryFor(state.current);
    applyFilter();
    renderList();

    /* The screenshot being looked at survives the regrouping, landing on whichever row
       now carries it. */
    const carrier = anchor && state.visible.find((entry) => setKeyOf(entry) === setKeyOf(anchor));
    if (carrier) {
      select(carrier.path);
    } else if (state.visible.length) {
      select(state.visible[0].path);
    }
  });

  dom.facets.addEventListener('click', (event) => {
    const button = event.target.closest('.count');
    if (!button) {
      return;
    }

    const selected = state.facets[button.closest('.facet').dataset.facet];
    const value = button.dataset.value;

    if (selected.has(value)) {
      selected.delete(value);
    } else {
      selected.add(value);
    }

    renderFacets();
    refilter();
  });

  dom.filter.addEventListener('input', refilter);

  dom.orphansOnly.addEventListener('change', refilter);

  dom.reencodedOnly.addEventListener('change', refilter);

  /* Focus would otherwise stay on the checkbox, where the review shortcuts are treated
     as typing and swallowed. */
  dom.unviewedOnly.addEventListener('change', (event) => {
    event.target.blur();
    refilter();
  });

  dom.theme.addEventListener('change', (event) => {
    applyTheme(event.target.value);
    event.target.blur();
  });

  dom.deleteComment.addEventListener('click', deleteCurrentComment);

  dom.publish.addEventListener('click', publishComments);

  dom.helpButton.addEventListener('click', () => dom.help.showModal());

  dom.help.addEventListener('click', (event) => {
    if (event.target === dom.help) {
      dom.help.close();
    }
  });

  window.addEventListener('resize', () => {
    if (state.zoom === 'fit') {
      applyZoom();
    }
  });
};
