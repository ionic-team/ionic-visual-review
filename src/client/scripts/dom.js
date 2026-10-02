/* Element lookups and the constants the rest of the client shares. */

/**
 * Looks up an element by id.
 * @param {string} id
 * @returns {HTMLElement | null}
 */
const el = (id) => document.getElementById(id);

export const dom = Object.fromEntries(
  [
    'stage', 'rangeLabel', 'rangeRefs', 'progressLabel', 'progressFill', 'helpButton', 'help', 'groupBrowsers',
    'filter', 'unviewedOnly', 'orphansOnly', 'orphansOnlyLabel', 'reencodedOnly', 'reencodedOnlyLabel', 'facets', 'carried', 'pushed', 'publish', 'list',
    'crumbStatus', 'crumbGroup', 'crumbTest', 'crumbStem', 'crumbBrowser', 'crumbMeta', 'crumbRatio', 'crumbResize',
    'crumbRenamed',
    'crumbOutdated', 'crumbOrphan', 'viewed',
    'modes', 'zoom', 'onionControl', 'onion', 'theme',
    'viewSxs', 'viewSlider', 'viewOnion', 'viewDiff',
    'figExpected', 'figActual', 'sxsExpected', 'sxsActual', 'bytesExpected', 'bytesActual',
    'labelExpected', 'labelActual',
    'sliderExpected', 'sliderActual',
    'onionSizer', 'onionExpected', 'onionActual',
    'diffImage', 'diffCount', 'notice', 'comment', 'commentSection', 'commentState', 'deleteComment', 'threads',
  ].map((id) => [id, el(id)])
);

export const VIEWS = { sxs: dom.viewSxs, slider: dom.viewSlider, onion: dom.viewOnion, diff: dom.viewDiff };

export const COMPARING = new Set(['slider', 'onion', 'diff']);

export const ZOOM_ORDER = ['fit', '1', '2'];

export const STATUS_LABEL = { M: 'Modified', A: 'Added', D: 'Removed', R: 'Renamed' };

/* Lower case for the facet bar, which reads as a sentence rather than a badge. */
export const STATUS_COUNT_LABEL = { M: 'modified', A: 'added', D: 'removed', R: 'renamed' };

/* Listed rather than discovered so a range missing one still knows it exists. */
export const BROWSER_ORDER = ['Mobile Chrome', 'Mobile Firefox', 'Mobile Safari'];
