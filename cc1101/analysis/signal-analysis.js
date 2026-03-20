// @ts-check

/**
 * @typedef {object} WallclockEdge
 * @property {number} level
 * @property {number} dtUs
 * @property {number} wallclockMs
 *
 * @typedef {WallclockEdge & {
 *   idx: number,
 *   snappedUs: number,
 *   units: number,
 *   smoothUnits?: number,
 * }} QuantizedSignalEdge
 *
 * @typedef {object} SignalTimingGrid
 * @property {number} baseUsRaw
 * @property {number} baseUs
 * @property {number[]} clustersUs
 *
 * @typedef {object} ConsensusToken
 * @property {number | null} level
 * @property {number | null} units
 */

const NICE_TIMINGS_US = [
  100, 125, 150, 175, 200, 225, 250, 275, 300, 325, 350, 375, 400, 450, 500,
  550, 600, 650, 700, 750, 800, 850, 900, 1000, 1100, 1200, 1250, 1500, 1750,
  2000, 2250, 2500, 3000, 3500, 4000, 4500, 5000, 6000,
];

/**
 * @param {number[]} values
 * @returns {number | null}
 */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * @param {number} us
 * @returns {number}
 */
function roundToNiceTiming(us) {
  let best = NICE_TIMINGS_US[0];
  let bestDiff = Math.abs(us - best);

  for (const timing of NICE_TIMINGS_US) {
    const diff = Math.abs(us - timing);
    if (diff < bestDiff) {
      best = timing;
      bestDiff = diff;
    }
  }

  return best;
}

/**
 * @param {WallclockEdge[]} edges
 * @param {number} historyMs
 * @returns {void}
 */
function trimHistory(edges, historyMs) {
  const cutoff = Date.now() - historyMs;
  while (edges.length && edges[0].wallclockMs < cutoff) {
    edges.shift();
  }
}

/**
 * @param {WallclockEdge[]} edges
 * @param {number} baseUs
 * @param {boolean=} niceSnap
 * @returns {QuantizedSignalEdge[]}
 */
function quantizeEdges(edges, baseUs, niceSnap = true) {
  return edges.map((edge, idx) => {
    const snappedUs = niceSnap ? roundToNiceTiming(edge.dtUs) : edge.dtUs;
    return {
      idx,
      level: edge.level,
      dtUs: edge.dtUs,
      wallclockMs: edge.wallclockMs,
      snappedUs,
      units: Math.max(1, Math.round(snappedUs / baseUs)),
    };
  });
}

/**
 * @param {QuantizedSignalEdge[]} quantizedEdges
 * @param {number} silenceUnits
 * @returns {QuantizedSignalEdge[][]}
 */
function splitBySilence(quantizedEdges, silenceUnits) {
  const frames = [];
  let current = [];

  for (const edge of quantizedEdges) {
    if (edge.units >= silenceUnits) {
      if (current.length) {
        frames.push(current);
        current = [];
      }
      continue;
    }

    current.push(edge);
  }

  if (current.length) frames.push(current);
  return frames;
}

/**
 * @param {QuantizedSignalEdge[]} quantized
 * @returns {QuantizedSignalEdge[]}
 */
function smoothQuantizedEdges(quantized) {
  if (quantized.length < 3) {
    return quantized.map((edge) => ({ ...edge, smoothUnits: edge.units }));
  }

  const out = quantized.map((edge) => ({ ...edge, smoothUnits: edge.units }));

  for (let i = 1; i < out.length - 1; i += 1) {
    const prev = out[i - 1];
    const cur = out[i];
    const next = out[i + 1];

    if (!(prev.level !== cur.level && cur.level !== next.level)) continue;

    if (
      cur.smoothUnits === 1 &&
      prev.smoothUnits >= 2 &&
      next.smoothUnits >= 2 &&
      Math.abs(prev.smoothUnits - next.smoothUnits) <= 1
    ) {
      cur.smoothUnits = Math.max(prev.smoothUnits, next.smoothUnits);
      continue;
    }

    if (
      cur.smoothUnits >= 2 &&
      prev.smoothUnits >= 3 &&
      next.smoothUnits >= 3 &&
      Math.abs(prev.smoothUnits - next.smoothUnits) <= 1 &&
      cur.smoothUnits + 1 < Math.min(prev.smoothUnits, next.smoothUnits)
    ) {
      cur.smoothUnits = Math.round((prev.smoothUnits + next.smoothUnits) / 2);
      continue;
    }

    if (prev.smoothUnits === 1 && next.smoothUnits === 1 && cur.smoothUnits >= 4) {
      cur.smoothUnits = 2;
    }
  }

  return out;
}

/**
 * @param {QuantizedSignalEdge[]} quantized
 * @param {number | null} sliceStart
 * @param {number | null} sliceEnd
 * @param {boolean=} useSmooth
 * @returns {Array<{ idx: number, level: number, units: number, rawUnits: number, dtUs: number, snappedUs: number }>}
 */
function buildSlice(quantized, sliceStart, sliceEnd, useSmooth = true) {
  const start = sliceStart === null ? 0 : Math.max(0, sliceStart);
  const end = sliceEnd === null ? quantized.length - 1 : Math.min(quantized.length - 1, sliceEnd);
  if (!quantized.length || start > end) return [];

  return quantized.slice(start, end + 1).map((edge) => ({
    idx: edge.idx,
    level: edge.level,
    units: useSmooth ? (edge.smoothUnits ?? edge.units) : edge.units,
    rawUnits: edge.units,
    dtUs: edge.dtUs,
    snappedUs: edge.snappedUs,
  }));
}

/**
 * @param {number[]} units
 * @param {number=} maxBars
 * @returns {string}
 */
function renderBars(units, maxBars = 120) {
  return units.slice(0, maxBars).map((unit) => {
    if (unit === null || unit === undefined) return "?";
    if (unit <= 1) return "▁";
    if (unit <= 2) return "▂";
    if (unit <= 3) return "▃";
    if (unit <= 5) return "▄";
    if (unit <= 8) return "▅";
    if (unit <= 12) return "▆";
    if (unit <= 20) return "▇";
    return "█";
  }).join("");
}

/**
 * @param {Array<{ level: number | null, units: number | null }>} tokens
 * @returns {string}
 */
function compactTokens(tokens) {
  return tokens.map((token) => {
    if (!token || token.level === null || token.units === null) return "??";
    const unit = token.units;
    const bucket =
      unit <= 1 ? "A" :
      unit <= 3 ? "B" :
      unit <= 6 ? "C" :
      unit <= 12 ? "D" : "E";
    return `${token.level}${bucket}`;
  }).join("");
}

/**
 * @param {QuantizedSignalEdge[]} frame
 * @returns {string}
 */
function compactFrame(frame) {
  return compactTokens(frame);
}

/**
 * @param {number[]} durationsUs
 * @returns {SignalTimingGrid}
 */
function estimateTimingGrid(durationsUs) {
  const usable = durationsUs.filter((duration) => duration >= 80 && duration <= 5000);
  if (usable.length < 8) {
    return {
      baseUsRaw: 250,
      baseUs: 250,
      clustersUs: [250, 500, 1000],
    };
  }

  const shortish = usable.filter((duration) => duration >= 80 && duration <= 1200);
  const baseRaw = shortish.length ? (median(shortish) ?? 250) : (median(usable) ?? 250);
  const baseUs = roundToNiceTiming(baseRaw);
  /** @type {Record<string, number>} */
  const buckets = {};

  for (const duration of usable) {
    const snapped = roundToNiceTiming(duration);
    buckets[String(snapped)] = (buckets[String(snapped)] || 0) + 1;
  }

  const clustersUs = Object.entries(buckets)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([timing]) => Number(timing))
    .sort((a, b) => a - b);

  return {
    baseUsRaw: baseRaw,
    baseUs,
    clustersUs,
  };
}

/**
 * @param {QuantizedSignalEdge[]} frame
 * @param {number=} minFrameEdges
 * @param {number=} maxFrameEdges
 * @returns {number}
 */
function scoreFrame(frame, minFrameEdges = 8, maxFrameEdges = 240) {
  if (!frame.length) return 0;

  const units = frame.map((edge) => edge.units);
  const unique = new Set(units).size;
  const nonTrivial = units.filter((unit) => unit >= 2).length;
  const alternating = frame.every((edge, index) => index === 0 || edge.level !== frame[index - 1].level);
  const leadingOnes = units.slice(0, 8).filter((unit) => unit === 1).length;
  const trailingOnes = units.slice(-8).filter((unit) => unit === 1).length;

  let score = 0;
  score += Math.min(frame.length, 40);
  score += Math.min(unique * 4, 20);
  score += Math.min(nonTrivial, 15);
  if (alternating) score += 8;

  if (frame.length < minFrameEdges) score -= 100;
  if (frame.length > maxFrameEdges) score -= 20;
  if (leadingOnes >= 6) score -= 10;
  if (trailingOnes >= 6) score -= 10;

  return score;
}

/**
 * @param {QuantizedSignalEdge[]} segment
 * @returns {number}
 */
function scoreSegment(segment) {
  const units = segment.map((edge) => edge.units);
  const unique = new Set(units).size;
  const ones = units.filter((unit) => unit === 1).length;
  const alternating = segment.every((edge, index) => index === 0 || edge.level !== segment[index - 1].level);

  let score = 0;
  score += Math.min(segment.length, 30);
  score += Math.min(unique * 4, 16);
  if (alternating) score += 6;
  if (ones / Math.max(1, segment.length) > 0.7) score -= 10;

  return score;
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * @param {Array<{ level: number, units: number }>} a
 * @param {Array<{ level: number, units: number }>} b
 * @param {number=} tolerance
 * @param {number=} maxShift
 * @returns {{
 *   shift: number,
 *   score: number,
 *   overlap: number,
 *   matched: Array<{ level: number, units: number }>,
 *   ratio: number,
 * } | null}
 */
function bestAlignment(a, b, tolerance = 1, maxShift = 8) {
  let best = null;

  for (let shift = -maxShift; shift <= maxShift; shift += 1) {
    let score = 0;
    let overlap = 0;
    /** @type {Array<{ level: number, units: number }>} */
    const matched = [];

    for (let i = 0; i < a.length; i += 1) {
      const j = i - shift;
      if (j < 0 || j >= b.length) continue;
      overlap += 1;

      if (a[i].level === b[j].level && Math.abs(a[i].units - b[j].units) <= tolerance) {
        score += 1;
        matched.push({
          level: a[i].level,
          units: Math.round((a[i].units + b[j].units) / 2),
        });
      }
    }

    const candidate = {
      shift,
      score,
      overlap,
      matched,
      ratio: overlap ? score / overlap : 0,
    };

    if (
      !best ||
      candidate.score > best.score ||
      (candidate.score === best.score && candidate.ratio > best.ratio)
    ) {
      best = candidate;
    }
  }

  return best;
}

/**
 * @param {Array<Array<{ level: number, units: number }>>} slices
 * @param {number=} tolerance
 * @returns {ConsensusToken[]}
 */
function buildConsensus(slices, tolerance = 1) {
  if (!slices.length) return [];

  const minLen = Math.min(...slices.map((slice) => slice.length));
  /** @type {ConsensusToken[]} */
  const consensus = [];

  for (let i = 0; i < minLen; i += 1) {
    const levels = slices.map((slice) => slice[i].level);
    const units = slices.map((slice) => slice[i].units);
    const sameLevel = levels.every((value) => value === levels[0]);
    const med = median(units);
    const sameUnit = med !== null && units.every((unit) => Math.abs(unit - med) <= tolerance);

    if (sameLevel && sameUnit && med !== null) {
      consensus.push({
        level: levels[0],
        units: med,
      });
    } else {
      consensus.push({
        level: null,
        units: null,
      });
    }
  }

  return consensus;
}

/**
 * @param {ConsensusToken[]} consensus
 * @returns {string}
 */
function matchMask(consensus) {
  return consensus.map((token) => (token.level === null ? "·" : "█")).join("");
}

module.exports = {
  bestAlignment,
  buildConsensus,
  buildSlice,
  clamp,
  compactFrame,
  compactTokens,
  estimateTimingGrid,
  matchMask,
  median,
  quantizeEdges,
  renderBars,
  roundToNiceTiming,
  scoreFrame,
  scoreSegment,
  smoothQuantizedEdges,
  splitBySilence,
  trimHistory,
};
