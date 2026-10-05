/*
 * Number formatting for sizes and change figures. No DOM, so it loads under Node.
 *
 * - A missing side's size is blank rather than 0 KB.
 * - No change reads 0%, and a change under 0.01% reads <0.01%, so the two never look
 *   the same.
 */

/**
 * Formats a size in kilobytes.
 * @param {number | null} bytes
 * @returns {string} Empty for a side that does not exist.
 */
export const kb = (bytes) => (bytes === null ? '' : `${(bytes / 1024).toFixed(1)} KB`);

/**
 * Formats a change ratio. Zero reads as 0% and a trace as <0.01%, so no change and
 * almost no change stay distinct.
 * @param {number | null} ratio
 * @returns {string}
 */
export const percent = (ratio) =>
  ratio === null ? '' : ratio === 0 ? '0%' : ratio < 0.0001 ? '<0.01%' : `${(ratio * 100).toFixed(2)}%`;
