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
 * @typedef {object} RawSignal
 * @property {number[]} levels
 * @property {number[]} durationsUs
 *
 * @typedef {object} SegmentedFrame
 * @property {number} index
 * @property {number} startEdgeIndex
 * @property {number} endEdgeIndex
 * @property {number} edges
 * @property {number} totalUs
 * @property {number[]} levels
 * @property {number[]} durationsUs
 */

const SPARK_BARS = "▁▂▃▄▅▆▇█";

/**
 * @param {number} value
 * @returns {string}
 */
function formatDurationUs(value) {
  if (!Number.isFinite(value)) return "0us";
  if (value >= 1000000) return `${(value / 1000000).toFixed(3)}s`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)}ms`;
  return `${Math.round(value)}us`;
}

/**
 * @param {number[]} durationsUs
 * @param {number} targetWidth
 * @returns {number}
 */
function chooseScaleUnitUs(durationsUs, targetWidth = 72) {
  const totalUs = durationsUs.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (totalUs <= 0) return 1;
  return Math.max(1, Math.ceil(totalUs / targetWidth));
}

/**
 * @param {any} capture
 * @returns {RawSignal | null}
 */
function extractRawSignal(capture) {
  if (Array.isArray(capture?.durationsUs) && Array.isArray(capture?.levels)) {
    return {
      levels: capture.levels.map((value) => Number(value)),
      durationsUs: capture.durationsUs.map((value) => Number(value)),
    };
  }

  if (Array.isArray(capture?.edges)) {
    return {
      levels: capture.edges.map((edge) => Number(edge.level)),
      durationsUs: capture.edges.map((edge) => Number(edge.dtUs)),
    };
  }

  return null;
}

/**
 * @param {any} capture
 * @param {number} silenceGapUs
 * @param {number} minEdges
 * @returns {SegmentedFrame[]}
 */
function segmentRawFrames(capture, silenceGapUs, minEdges = 1) {
  const signal = extractRawSignal(capture);
  if (!signal) return [];

  const levels = signal.levels;
  const durationsUs = signal.durationsUs;
  if (!levels.length || levels.length !== durationsUs.length) return [];

  const frames = [];
  /** @type {{ startEdgeIndex: number, levels: number[], durationsUs: number[] } | null} */
  let current = null;

  const pushCurrent = () => {
    if (!current || current.levels.length < minEdges) {
      current = null;
      return;
    }

    frames.push({
      index: frames.length,
      startEdgeIndex: current.startEdgeIndex,
      endEdgeIndex: current.startEdgeIndex + current.levels.length - 1,
      edges: current.levels.length,
      totalUs: current.durationsUs.reduce((sum, value) => sum + value, 0),
      levels: current.levels.slice(),
      durationsUs: current.durationsUs.slice(),
    });
    current = null;
  };

  for (let i = 0; i < levels.length; i += 1) {
    const level = levels[i];
    const dtUs = durationsUs[i];

    if (!current) {
      current = {
        startEdgeIndex: i,
        levels: [level],
        durationsUs: [0],
      };
      continue;
    }

    if (dtUs >= silenceGapUs) {
      pushCurrent();
      current = {
        startEdgeIndex: i,
        levels: [level],
        durationsUs: [0],
      };
      continue;
    }

    current.levels.push(level);
    current.durationsUs.push(dtUs);
  }

  pushCurrent();
  return frames;
}

/**
 * @param {any} capture
 * @param {{ targetWidth?: number, maxLabels?: number }=} options
 * @returns {string | null}
 */
function renderRawSignal(capture, options = {}) {
  const signal = extractRawSignal(capture);
  if (!signal) return null;

  const levels = signal.levels;
  const durationsUs = signal.durationsUs;
  if (!levels.length || !durationsUs.length || levels.length !== durationsUs.length) return null;

  const maxDurationUs = Math.max(...durationsUs, 1);
  const unitUs = chooseScaleUnitUs(durationsUs, options.targetWidth ?? 72);
  const totalUs = durationsUs.reduce((sum, value) => sum + value, 0);
  const shape = durationsUs.map((dtUs) => {
    const ratio = Math.max(0, Math.min(1, dtUs / maxDurationUs));
    const index = Math.min(SPARK_BARS.length - 1, Math.round(ratio * (SPARK_BARS.length - 1)));
    return SPARK_BARS[index];
  }).join("");
  const timeline = durationsUs.map((dtUs, index) => {
    const width = Math.max(1, Math.round(dtUs / unitUs));
    return (levels[index] ? "▀" : "▄").repeat(width);
  }).join("");
  const labels = durationsUs
    .slice(0, options.maxLabels ?? 24)
    .map((dtUs, index) => `${levels[index]}@${formatDurationUs(dtUs)}`)
    .join("  ");

  return [
    `signal:    edges=${durationsUs.length}  total=${formatDurationUs(totalUs)}  scale=1col:${formatDurationUs(unitUs)}`,
    `shape:     ${shape}`,
    `timeline:  ${timeline}`,
    `edges:     ${labels}${durationsUs.length > (options.maxLabels ?? 24) ? "  ..." : ""}`,
  ].join("\n");
}

/**
 * @param {any} capture
 * @param {{ silenceGapUs: number, minEdges?: number, targetWidth?: number, maxLabels?: number }} options
 * @returns {string | null}
 */
function renderSegmentedFrames(capture, options) {
  const frames = segmentRawFrames(capture, options.silenceGapUs, options.minEdges ?? 1);
  if (!frames.length) return null;

  const lines = [
    `frames:    count=${frames.length}  silenceGap=${formatDurationUs(options.silenceGapUs)}  minEdges=${options.minEdges ?? 1}`,
  ];

  for (const frame of frames) {
    lines.push("");
    lines.push(`frame[${frame.index}] edges=${frame.edges} sourceEdges=${frame.startEdgeIndex}..${frame.endEdgeIndex} total=${formatDurationUs(frame.totalUs)}`);
    lines.push(renderRawSignal(frame, {
      targetWidth: options.targetWidth,
      maxLabels: options.maxLabels,
    }) ?? "signal:    unavailable");
  }

  return lines.join("\n");
}

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
  extractRawSignal,
  loadCaptureFile,
  renderRawSignal,
  renderSegmentedFrames,
  saveCaptureFile,
  segmentRawFrames,
  summarizeCaptureFile,
};
