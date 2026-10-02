/* The stage: comparison modes, zoom and the selected screenshot. */
import { renderDelete, renderThreads } from './comments.js';
import { COMPARING, STATUS_LABEL, VIEWS, dom } from './dom.js';
import { entryFor, worthComparing } from './entries.js';
import { kb, percent } from './format.js';
import { blobUrl, setCaptionLink, setTestLink } from './links.js';
import { state } from './state.js';

/** @typedef {import('./state.js').Entry} Entry */

const STAGE_PADDING = 40;

const SXS_GAP = 18;

const FIT_MAX_SCALE = 3;

/**
 * The scale that fits a screenshot on the stage, capped at 3x. Side by side gets half
 * the width each.
 * @param {Entry} entry
 * @param {string} mode
 * @returns {number}
 */
const fitScale = (entry, mode) => {
  const sxs = mode === 'sxs' && entry.comparable;
  const width = dom.stage.clientWidth - STAGE_PADDING;
  const height = dom.stage.clientHeight - STAGE_PADDING - 24;
  return Math.min((sxs ? (width - SXS_GAP) / 2 : width) / entry.size.width, height / entry.size.height, FIT_MAX_SCALE);
};

/** Applies the zoom to all four views through one CSS variable. */
export const applyZoom = () => {
  const entry = entryFor(state.current);

  if (entry?.size) {
    const mode = entry.comparable ? state.mode : 'sxs';
    const scale = state.zoom === 'fit' ? fitScale(entry, mode) : Number(state.zoom);
    document.documentElement.style.setProperty('--shot-width', `${Math.round(entry.size.width * scale)}px`);
    dom.stage.classList.toggle('upscaled', scale > 1.05);
  }

  for (const button of dom.zoom.children) {
    button.classList.toggle('active', button.dataset.zoom === state.zoom);
  }
};

/**
 * Shows the chosen comparison view, falling back to side by side when there is nothing
 * to compare.
 */
export const applyMode = () => {
  const entry = entryFor(state.current);
  const comparable = worthComparing(entry);
  const mode = comparable ? state.mode : 'sxs';

  for (const button of dom.modes.children) {
    button.disabled = COMPARING.has(button.dataset.mode) && !comparable;
    button.classList.toggle('active', button.dataset.mode === mode);
  }

  for (const [name, view] of Object.entries(VIEWS)) {
    view.classList.toggle('show', name === mode);
  }

  dom.onionControl.classList.toggle('show', mode === 'onion');
};

/**
 * Shows a screenshot on the stage and brings the crumbs, notice, comment box and
 * controls in line with it.
 * @param {string} path
 * @param {{ scroll?: boolean }} [options] `scroll` brings its row into view.
 */
export const select = (path, { scroll = true } = {}) => {
  const entry = entryFor(path);
  if (!entry) {
    return;
  }

  state.current = path;

  for (const row of dom.list.querySelectorAll('.row')) {
    row.classList.toggle('selected', row.dataset.path === path);
  }
  if (scroll) {
    dom.list.querySelector('.row.selected')?.scrollIntoView({ block: 'nearest' });
  }

  dom.crumbStatus.className = `badge ${entry.status}`;
  dom.crumbStatus.textContent = STATUS_LABEL[entry.status];
  dom.crumbGroup.textContent = entry.group;
  setTestLink(entry);
  dom.crumbStem.textContent = entry.stem;
  dom.crumbBrowser.textContent = entry.browser ?? '';
  dom.crumbMeta.textContent = entry.size ? `${entry.size.width} × ${entry.size.height}` : '';
  dom.crumbRatio.textContent = entry.ratio === null ? '' : `${percent(entry.ratio)} changed`;
  dom.crumbResize.textContent =
    entry.resized && entry.expectedSize && entry.actualSize
      ? `resized ${entry.expectedSize.width}×${entry.expectedSize.height} → ${entry.actualSize.width}×${entry.actualSize.height}`
      : '';
  /*
   * Where it moved from, naming only the part that actually changed. These usually
   * keep their filename and change directory, so repeating an identical stem would
   * bury the one difference that matters.
   */
  const movedDir = Boolean(entry.oldGroup) && entry.oldGroup !== entry.group;
  const movedName = Boolean(entry.oldStem) && entry.oldStem !== entry.stem;

  dom.crumbRenamed.hidden = !movedDir && !movedName;
  dom.crumbRenamed.textContent =
    movedDir && movedName
      ? `from ${entry.oldGroup} / ${entry.oldStem}`
      : movedDir
        ? `from ${entry.oldGroup}`
        : `was ${entry.oldStem}`;
  dom.crumbRenamed.title = entry.oldPath ?? '';

  const expected = entry.status === 'A' ? null : blobUrl('expected', entry.path);
  const actual = entry.status === 'D' ? null : blobUrl('actual', entry.path);

  /* The baseline is hidden when it would be the same picture twice. */
  dom.figExpected.hidden = !expected || (entry.comparable && entry.ratio === 0);
  dom.figActual.hidden = !actual;
  dom.sxsExpected.src = expected ?? '';
  dom.sxsActual.src = actual ?? '';
  dom.bytesExpected.textContent = kb(entry.bytes.expected);
  dom.bytesActual.textContent = kb(entry.bytes.actual);

  /* A renamed screenshot's baseline lives at its old path. */
  setCaptionLink(dom.labelExpected, 'expected', expected ? (entry.oldPath ?? entry.path) : null, entry.status);
  setCaptionLink(dom.labelActual, 'actual', actual ? entry.path : null, entry.status);

  if (worthComparing(entry)) {
    dom.sliderExpected.src = expected;
    dom.sliderActual.src = actual;
    /* The frame must be sized by whichever version is taller, or the shorter one
       would clip the taller. */
    dom.onionSizer.src = (entry.actualSize?.height ?? 0) >= (entry.expectedSize?.height ?? 0) ? actual : expected;
    dom.onionExpected.src = expected;
    dom.onionActual.src = actual;
    dom.diffImage.src = blobUrl('diff', entry.path);
    dom.diffCount.textContent = entry.changed === null ? '' : `${entry.changed.toLocaleString()} pixels`;
    dom.notice.classList.remove('show');
  } else {
    dom.notice.classList.add('show');

    /* Three ways to end up here, and they are worth telling apart: one side is
       missing, the bytes are the same, or only the encoding changed. The caption
       already says added or removed, so this explains what it does not. */
    if (!entry.comparable) {
      dom.notice.textContent = 'Only one version of this screenshot exists, so there is nothing to compare.';
    } else if (entry.expectedSha === entry.actualSha) {
      /* The badge and the crumbs already say it was renamed and where from, and they
         say it for every rename, including the ones that also changed and so never
         reach this notice. All that is left to explain is the empty stage. */
      dom.notice.textContent = 'Byte for byte identical to the original, so there is nothing to compare.';
    } else {
      dom.notice.textContent = 'No pixel changed. Only the encoding differs, so there is nothing to see.';
    }
  }

  /* One hook for the stage, so the removed treatment lives in CSS rather than being
     assembled here. */
  dom.stage.dataset.status = entry.status;

  /* Flagged in the crumbs rather than explained again. The sidebar already carries
     the sentence and the button; repeating both next to the image said the same
     thing twice with two identical buttons. */
  dom.crumbOutdated.hidden = !state.changedByPush.has(entry.path);

  dom.crumbOrphan.hidden = !entry.orphaned;
  dom.crumbOrphan.title = 'It will keep being regenerated until the file is deleted.';

  dom.viewed.checked = state.viewed.has(entry.path);
  dom.comment.value = state.comments.get(entry.path) ?? '';
  renderThreads();
  renderDelete();
  dom.commentState.textContent = state.stale.has(entry.path) ? 'Written before this screenshot changed' : '';
  dom.comment.classList.toggle('stale', state.stale.has(entry.path));

  applyMode();
  applyZoom();
};
