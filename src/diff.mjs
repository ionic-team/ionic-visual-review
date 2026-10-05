/*
 * Pixel comparison of two screenshots.
 *
 * - Compared with pixelmatch at a 0.1 threshold. Antialiasing differences are
 *   ignored and painted yellow in the diff image; real changes are painted red over
 *   a dimmed copy of the screenshot.
 * - When the sizes differ, both are padded top left onto the larger canvas, so added
 *   or removed rows count as changed rather than being scaled away.
 * - The ratio is changed pixels over that canvas. Zero means identical pixels, even
 *   when the files' bytes differ.
 */
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/** @typedef {{ width: number, height: number }} Size */

/**
 * @typedef {object} Comparison
 * @property {boolean} resized Whether the two sizes differ.
 * @property {number} changed Changed pixels.
 * @property {number} ratio Changed pixels as a share of the canvas.
 * @property {Buffer} png The diff image.
 * @property {Size} size The common canvas both were padded to.
 * @property {Size} expectedSize
 * @property {Size} actualSize
 */

/*
 * A CSS blend mode is enough to show where something moved, but not how much moved.
 * pixelmatch gives a real diff image and a changed-pixel count, which is what makes
 * sorting several hundred screenshots by magnitude possible.
 */

const THRESHOLD = 0.1;

/**
 * Copies a PNG onto a larger transparent canvas, anchored top left, so extra rows
 * count as changed rather than being scaled away.
 * @param {PNG} png Decoded image.
 * @param {number} width Target width.
 * @param {number} height Target height.
 * @returns {PNG} The same image when it is already that size.
 */
const padTo = (png, width, height) => {
  if (png.width === width && png.height === height) {
    return png;
  }

  const canvas = new PNG({ width, height });
  PNG.bitblt(png, canvas, 0, 0, png.width, png.height, 0, 0);
  return canvas;
};

/**
 * Diffs two PNGs, padding both to a common canvas when their sizes differ.
 * @param {Buffer} expectedBuffer The baseline image.
 * @param {Buffer} actualBuffer The image from the branch.
 * @returns {Comparison}
 */
export const comparePng = (expectedBuffer, actualBuffer) => {
  const expectedPng = PNG.sync.read(expectedBuffer);
  const actualPng = PNG.sync.read(actualBuffer);

  const width = Math.max(expectedPng.width, actualPng.width);
  const height = Math.max(expectedPng.height, actualPng.height);
  const resized = expectedPng.width !== actualPng.width || expectedPng.height !== actualPng.height;

  const expected = padTo(expectedPng, width, height);
  const actual = padTo(actualPng, width, height);

  const diff = new PNG({ width, height });
  const changed = pixelmatch(expected.data, actual.data, diff.data, width, height, {
    threshold: THRESHOLD,
    includeAA: false,
    /* Dim the unchanged pixels rather than dropping them, so the diff still reads as
       the component instead of as disconnected specks. */
    alpha: 0.25,
    diffColor: [255, 61, 87],
    aaColor: [255, 195, 0],
  });

  return {
    resized,
    changed,
    ratio: changed / (width * height),
    png: PNG.sync.write(diff),
    /* Both natural sizes, so the client can lay the overlay views out without
       scaling either image to fit the other. */
    size: { width, height },
    expectedSize: { width: expectedPng.width, height: expectedPng.height },
    actualSize: { width: actualPng.width, height: actualPng.height },
  };
};

/**
 * Reads width and height from the PNG header without decoding the image.
 * @param {Buffer} buffer
 * @returns {Size | null} Null when the buffer is too short to be a PNG.
 */
export const pngSize = (buffer) => {
  if (!buffer || buffer.length < 24) {
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};
