// @ts-check

const fs = require("fs");
const path = require("path");

/**
 * @typedef {object} CaptureFileSummary
 * @property {string | null} ts
 * @property {number | null} triggerRssi
 * @property {number | null} edgeCount
 * @property {number | null} baseUs
 * @property {string[]} fields
 */

/**
 * @param {string} outDir
 * @param {string} prefix
 * @param {number} id
 * @param {string} isoTs
 * @returns {string}
 */
function buildCaptureFilepath(outDir, prefix, id, isoTs) {
  const stamp = isoTs.replace(/[:.]/g, "-");
  const filename = `${prefix}-${String(id).padStart(3, "0")}-${stamp}.json`;
  return path.join(outDir, filename);
}

/**
 * @param {string} filepath
 * @param {unknown} capture
 * @returns {void}
 */
function saveCaptureFile(filepath, capture) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify(capture, null, 2), "utf8");
}

/**
 * @param {string} filepath
 * @returns {any}
 */
function loadCaptureFile(filepath) {
  return JSON.parse(fs.readFileSync(filepath, "utf8"));
}

/**
 * @param {any} capture
 * @returns {CaptureFileSummary}
 */
function summarizeCaptureFile(capture) {
  return {
    ts: capture?.ts ?? null,
    triggerRssi: capture?.triggerRssi ?? null,
    edgeCount: capture?.edgeCount ?? capture?.edges?.length ?? null,
    baseUs: capture?.baseUs ?? null,
    fields: Object.keys(capture ?? {}).sort(),
  };
}

module.exports = {
  buildCaptureFilepath,
  loadCaptureFile,
  saveCaptureFile,
  summarizeCaptureFile,
};
