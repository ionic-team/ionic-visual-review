/*
 * Keyboard shortcuts, as listed in the help dialog.
 *
 * - Ignored while typing in a field, while a modifier key is held, or while help is
 *   open. Escape leaves a field.
 * - v toggles the open screenshot's mark and moves on. n jumps to the next unviewed,
 *   wrapping to the top.
 * - Shift+V marks the open screenshot's directory, or unmarks it when all of it is
 *   viewed, covering only what the filters admit.
 * - c focuses the comment box only when it is shown: a pull request with gh signed in.
 */
import { ZOOM_ORDER, dom } from './dom.js';
import { countViewed, entryFor, groupScope } from './entries.js';
import { refilter } from './filters.js';
import { nextUnviewed, setViewed, step, toggleGroup } from './navigation.js';
import { applyZoom } from './stage.js';
import { state } from './state.js';

/**
 * Handles the shortcuts listed in the help dialog, except while typing or while help is
 * open.
 */
export const wireKeyboard = () => {
  document.addEventListener('keydown', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);

    if (event.key === 'Escape') {
      if (typing) {
        target.blur();
      }
      return;
    }

    if (typing || event.metaKey || event.ctrlKey || event.altKey || dom.help.open) {
      return;
    }

    const actions = {
      j: () => step(1),
      ArrowDown: () => step(1),
      k: () => step(-1),
      ArrowUp: () => step(-1),
      v: () => setViewed(!state.viewed.has(state.current), { advance: true }),
      V: () => {
        const entry = entryFor(state.current);
        if (entry) {
          const entries = groupScope(entry.group);
          toggleGroup(entry.group, countViewed(entries) < entries.length);
        }
      },
      n: nextUnviewed,
      1: () => dom.modes.querySelectorAll('button')[0].click(),
      2: () => dom.modes.querySelectorAll('button')[1].click(),
      3: () => dom.modes.querySelectorAll('button')[2].click(),
      4: () => dom.modes.querySelectorAll('button')[3].click(),
      z: () => {
        state.zoom = ZOOM_ORDER[(ZOOM_ORDER.indexOf(state.zoom) + 1) % ZOOM_ORDER.length];
        applyZoom();
      },
      c: () => {
        if (state.pr && state.viewer) {
          dom.comment.focus();
        }
      },
      '/': () => dom.filter.focus(),
      u: () => {
        dom.unviewedOnly.checked = !dom.unviewedOnly.checked;
        refilter();
      },
      '?': () => dom.help.showModal(),
    };

    const action = actions[event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  });
};
