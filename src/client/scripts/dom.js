/* Element lookups and the constants the rest of the client shares. */

const IDS = /** @type {const} */ ([
  'stage',
  'rangeLabel',
  'rangeRefs',
  'progressLabel',
  'progressFill',
  'helpButton',
  'help',
  'groupBrowsers',
  'filter',
  'unviewedOnly',
  'orphansOnly',
  'orphansOnlyLabel',
  'reencodedOnly',
  'reencodedOnlyLabel',
  'facets',
  'carried',
  'pushed',
  'publish',
  'list',
  'crumbStatus',
  'crumbGroup',
  'crumbTest',
  'crumbStem',
  'crumbBrowser',
  'crumbMeta',
  'crumbRatio',
  'crumbResize',
  'crumbRenamed',
  'crumbOutdated',
  'crumbOrphan',
  'viewed',
  'modes',
  'zoom',
  'onionControl',
  'onion',
  'theme',
  'viewSxs',
  'viewSlider',
  'viewOnion',
  'viewDiff',
  'figExpected',
  'figActual',
  'sxsExpected',
  'sxsActual',
  'bytesExpected',
  'bytesActual',
  'labelExpected',
  'labelActual',
  'sliderExpected',
  'sliderActual',
  'onionSizer',
  'onionExpected',
  'onionActual',
  'diffImage',
  'diffCount',
  'notice',
  'comment',
  'commentSection',
  'commentState',
  'deleteComment',
  'threads',
]);

/**
 * Every id as an HTMLElement, narrowed where scripts use more than that offers.
 * @typedef {Record<(typeof IDS)[number], HTMLElement>
 *   & Record<'rangeLabel' | 'crumbTest', HTMLAnchorElement>
 *   & Record<'helpButton' | 'publish' | 'deleteComment', HTMLButtonElement>
 *   & Record<'groupBrowsers' | 'filter' | 'unviewedOnly' | 'orphansOnly' | 'reencodedOnly' | 'viewed' | 'onion', HTMLInputElement>
 *   & Record<'sxsExpected' | 'sxsActual' | 'sliderExpected' | 'sliderActual' | 'onionSizer' | 'onionExpected' | 'onionActual' | 'diffImage', HTMLImageElement>
 *   & { help: HTMLDialogElement, theme: HTMLSelectElement, comment: HTMLTextAreaElement }} Dom
 */

export const dom = /** @type {Dom} */ (Object.fromEntries(IDS.map((id) => [id, document.getElementById(id)])));

export const VIEWS = { sxs: dom.viewSxs, slider: dom.viewSlider, onion: dom.viewOnion, diff: dom.viewDiff };

export const COMPARING = new Set(['slider', 'onion', 'diff']);

export const ZOOM_ORDER = ['fit', '1', '2'];

export const STATUS_LABEL = { M: 'Modified', A: 'Added', D: 'Removed', R: 'Renamed' };

/* Lower case for the facet bar, which reads as a sentence rather than a badge. */
export const STATUS_COUNT_LABEL = { M: 'modified', A: 'added', D: 'removed', R: 'renamed' };

/* Listed rather than discovered so a range missing one still knows it exists. */
export const BROWSER_ORDER = ['Mobile Chrome', 'Mobile Firefox', 'Mobile Safari'];
