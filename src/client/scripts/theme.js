/*
 * Light, dark and system theme.
 *
 * - System follows the operating system, and is the default.
 * - The choice is remembered in this browser. Where storage is blocked, as in a
 *   private window, it still applies until the page closes.
 */
import { dom } from './dom.js';

const THEME_KEY = 'snapshot-review-theme';

/** @typedef {'system' | 'light' | 'dark'} Theme */

/**
 * Applies a theme and remembers it in this browser. System removes the attribute, so the
 * stylesheet follows the operating system.
 * @param {Theme} choice
 */
export const applyTheme = (choice) => {
  if (choice === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.dataset.theme = choice;
  }

  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* Private windows and blocked storage. The choice still applies for this page. */
  }
};

/** Applies the remembered theme, or system when there is none. */
export const restoreTheme = () => {
  let stored = 'system';
  try {
    stored = localStorage.getItem(THEME_KEY) ?? 'system';
  } catch {
    /* Unreadable storage reads as no preference. */
  }

  const choice = /** @type {Theme} */ (['system', 'light', 'dark'].includes(stored) ? stored : 'system');
  dom.theme.value = choice;
  applyTheme(choice);
};
