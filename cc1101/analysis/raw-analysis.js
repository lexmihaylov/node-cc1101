// @ts-check

/**
 * @typedef {object} RawFrame
 * @property {string} ts
 * @property {string} reason
 * @property {number | null} triggerRssi
 * @property {number} edges
 * @property {number[]} durationsUs
 * @property {number[]} levels
 *
 * @typedef {object} RawSegmentSummary
 * @property {number[]} units
 * @property {string} symbols
 * @property {string} compact
 * @property {string} bits
 *
 * @typedef {object} RawFrameSummary
 * @property {string} ts
 * @property {number} edges
 * @property {number | null} triggerRssi
 * @property {number} baseUnitUs
 * @property {number[]} units
 * @property {RawSegmentSummary[]} segments
 */

/**
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * @param {number[]} durationsUs
 * @returns {number}
 */
function estimateBaseUnit(durationsUs) {
  const candidates = durationsUs.filter((duration) => duration >= 100 && duration <= 700);
  if (!candidates.length) return 125;
  return median(candidates);
}

/**
 * @param {number[]} durationsUs
 * @param {number} baseUnitUs
 * @returns {number[]}
 */
function normalizeToUnits(durationsUs, baseUnitUs) {
  return durationsUs.map((duration) => Math.max(1, Math.round(duration / baseUnitUs)));
}

/**
 * @param {number[]} units
 * @param {number=} gapThreshold
 * @returns {number[][]}
 */
function splitIntoSegments(units, gapThreshold = 20) {
  const segments = [];
  let current = [];

  for (const unit of units) {
    if (unit > gapThreshold) {
      if (current.length) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(unit);
  }

  if (current.length) segments.push(current);
  return segments;
}

/**
 * @param {number} unit
 * @returns {string}
 */
function classifyUnit(unit) {
  if (unit <= 1) return "A";
  if (unit <= 3) return "B";
  if (unit <= 6) return "C";
  if (unit <= 12) return "D";
  return "E";
}

/**
 * @param {number[]} segment
 * @returns {string}
 */
function segmentToSymbols(segment) {
  return segment.map(classifyUnit).join("");
}

/**
 * @param {string} symbols
 * @returns {string}
 */
function compressSymbols(symbols) {
  if (!symbols.length) return "";
  let out = symbols[0];
  let count = 1;

  for (let i = 1; i < symbols.length; i += 1) {
    if (symbols[i] === symbols[i - 1]) {
      count += 1;
    } else {
      out += count > 1 ? String(count) : "";
      out += symbols[i];
      count = 1;
    }
  }

  out += count > 1 ? String(count) : "";
  return out;
}

/**
 * @param {number} a
 * @param {number} b
 * @returns {string}
 */
function classifyPair(a, b) {
  const aShort = a <= 3;
  const bShort = b <= 3;
  const aLong = a >= 4 && a <= 10;
  const bLong = b >= 4 && b <= 10;

  if (aShort && bLong) return "0";
  if (aLong && bShort) return "1";
  return "?";
}

/**
 * @param {number[]} segment
 * @returns {string}
 */
function decodeSegmentToBits(segment) {
  const bits = [];
  for (let i = 0; i < segment.length - 1; i += 2) {
    bits.push(classifyPair(segment[i], segment[i + 1]));
  }
  return bits.join("");
}

/**
 * @param {number[]} values
 * @param {number=} maxBars
 * @returns {string}
 */
function renderBars(values, maxBars = 80) {
  return values.slice(0, maxBars).map((value) => {
    if (value <= 1) return "▁";
    if (value <= 2) return "▂";
    if (value <= 3) return "▃";
    if (value <= 5) return "▄";
    if (value <= 8) return "▅";
    if (value <= 12) return "▆";
    if (value <= 20) return "▇";
    return "█";
  }).join("");
}

/**
 * @param {number[]} values
 * @param {number=} maxWidth
 * @param {number=} startLevel
 * @returns {string}
 */
function renderWaveform(values, maxWidth = 120, startLevel = 1) {
  const parts = [];
  let level = startLevel;

  for (const value of values) {
    const width = Math.max(1, Math.min(value, 20));
    parts.push((level ? "█" : "_").repeat(width));
    level = level ? 0 : 1;
  }

  const full = parts.join("");
  if (full.length <= maxWidth) return full;

  const step = full.length / maxWidth;
  let out = "";
  for (let i = 0; i < maxWidth; i += 1) {
    out += full[Math.floor(i * step)];
  }
  return out;
}

/**
 * @param {RawFrame} frame
 * @returns {RawFrameSummary | null}
 */
function summarizeFrame(frame) {
  const filtered = frame.durationsUs.filter((duration) => duration >= 80);
  if (filtered.length < 12) return null;

  const baseUnitUs = estimateBaseUnit(filtered);
  const units = normalizeToUnits(filtered, baseUnitUs);
  const segments = splitIntoSegments(units, 20)
    .filter((segment) => segment.length >= 8)
    .map((segment) => {
      const symbols = segmentToSymbols(segment);
      return {
        units: segment,
        symbols,
        compact: compressSymbols(symbols),
        bits: decodeSegmentToBits(segment),
      };
    });

  return {
    ts: frame.ts,
    edges: frame.edges,
    triggerRssi: frame.triggerRssi,
    baseUnitUs,
    units,
    segments,
  };
}

module.exports = {
  classifyPair,
  classifyUnit,
  compressSymbols,
  decodeSegmentToBits,
  estimateBaseUnit,
  median,
  normalizeToUnits,
  renderBars,
  renderWaveform,
  segmentToSymbols,
  splitIntoSegments,
  summarizeFrame,
};
