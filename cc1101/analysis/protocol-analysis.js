// @ts-check

/**
 * @typedef {object} QuantizedEdge
 * @property {number} level
 * @property {number} dtUs
 * @property {number} wallclockMs
 * @property {number} snappedUs
 * @property {number} units
 *
 * @typedef {object} ProtocolRanking
 * @property {string} name
 * @property {number} score
 * @property {string | null} bits
 * @property {string} details
 *
 * @typedef {object} ProtocolCandidate
 * @property {QuantizedEdge[]} frame
 * @property {number} frameScore
 * @property {ProtocolRanking[]} rankings
 *
 * @typedef {object} DecodedProtocolResult
 * @property {string} protocol
 * @property {number} confidence
 * @property {string} bits
 * @property {string} cleanBits
 * @property {Record<string, string> | null} fields
 * @property {string} details
 */

/**
 * @param {number} us
 * @returns {number}
 */
function roundToNiceTiming(us) {
  const nice = [
    100, 125, 150, 175, 200, 225, 250, 275, 300, 325, 350, 375, 400, 450,
    500, 550, 600, 650, 700, 750, 800, 850, 900, 1000, 1100, 1200, 1250,
    1500, 1750, 2000, 2250, 2500, 3000, 3500, 4000, 4500, 5000, 6000,
  ];

  let best = nice[0];
  let bestDiff = Math.abs(us - best);

  for (const n of nice) {
    const diff = Math.abs(us - n);
    if (diff < bestDiff) {
      best = n;
      bestDiff = diff;
    }
  }

  return best;
}

/**
 * @param {number} dtUs
 * @param {number} baseUs
 * @returns {number}
 */
function snapToBase(dtUs, baseUs) {
  return Math.max(1, Math.round(dtUs / baseUs));
}

/**
 * @param {{ level: number, dtUs: number, wallclockMs: number }[]} edges
 * @param {number} baseUs
 * @param {boolean=} niceSnap
 * @returns {QuantizedEdge[]}
 */
function quantizeEdges(edges, baseUs, niceSnap = true) {
  return edges.map((edge) => {
    const snappedUs = niceSnap ? roundToNiceTiming(edge.dtUs) : edge.dtUs;

    return {
      ...edge,
      snappedUs,
      units: snapToBase(snappedUs, baseUs),
    };
  });
}

/**
 * @param {QuantizedEdge[]} quantizedEdges
 * @param {number} silenceUnits
 * @returns {QuantizedEdge[][]}
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
 * @param {number[]} units
 * @param {number=} maxBars
 * @returns {string}
 */
function renderBars(units, maxBars = 120) {
  return units.slice(0, maxBars).map((u) => {
    if (u <= 1) return "▁";
    if (u <= 2) return "▂";
    if (u <= 3) return "▃";
    if (u <= 5) return "▄";
    if (u <= 8) return "▅";
    if (u <= 12) return "▆";
    if (u <= 20) return "▇";
    return "█";
  }).join("");
}

/**
 * @param {QuantizedEdge[]} frame
 * @returns {string}
 */
function compactFrame(frame) {
  return frame.map((edge) => {
    const unit = edge.units;
    const bucket =
      unit <= 1 ? "A" :
      unit <= 3 ? "B" :
      unit <= 6 ? "C" :
      unit <= 12 ? "D" : "E";

    return `${edge.level}${bucket}`;
  }).join("");
}

/**
 * @param {QuantizedEdge[]} frame
 * @returns {{
 *   units: number[],
 *   unique: number,
 *   alternating: boolean,
 *   ones: number,
 *   twos: number,
 *   threes: number,
 *   big: number,
 *   length: number
 * }}
 */
function frameStats(frame) {
  const units = frame.map((edge) => edge.units);
  const unique = new Set(units).size;
  const alternating = frame.every((edge, index) => index === 0 || edge.level !== frame[index - 1].level);
  const ones = units.filter((u) => u === 1).length;
  const twos = units.filter((u) => u === 2).length;
  const threes = units.filter((u) => u === 3).length;
  const big = units.filter((u) => u >= 6).length;

  return {
    units,
    unique,
    alternating,
    ones,
    twos,
    threes,
    big,
    length: frame.length,
  };
}

/**
 * @param {QuantizedEdge[]} frame
 * @param {number} minFrameEdges
 * @param {number} maxFrameEdges
 * @returns {number}
 */
function scoreFrame(frame, minFrameEdges, maxFrameEdges) {
  const stats = frameStats(frame);
  let score = 0;

  score += Math.min(frame.length, 40);
  score += Math.min(stats.unique * 4, 20);
  if (stats.alternating) score += 8;
  score += Math.min(stats.big * 2, 10);

  if (frame.length < minFrameEdges) score -= 100;
  if (frame.length > maxFrameEdges) score -= 20;
  if (stats.ones / Math.max(1, frame.length) > 0.65) score -= 12;

  return score;
}

/**
 * @param {QuantizedEdge[]} frame
 * @returns {[QuantizedEdge, QuantizedEdge?][]}
 */
function pairsFromFrame(frame) {
  const pairs = [];
  for (let i = 0; i < frame.length - 1; i += 2) {
    pairs.push([frame[i], frame[i + 1]]);
  }
  return pairs;
}

/**
 * @param {QuantizedEdge[]} frame
 * @param {[number, number]} zeroPattern
 * @param {[number, number]} onePattern
 * @param {number=} tolerance
 * @returns {{ bits: string, matched: number, totalPairs: number, ratio: number }}
 */
function bitStringFromPairs(frame, zeroPattern, onePattern, tolerance = 1) {
  const pairs = pairsFromFrame(frame);
  let bits = "";
  let matched = 0;

  for (const [a, b] of pairs) {
    if (!b) continue;

    const match = (pattern) =>
      Math.abs(a.units - pattern[0]) <= tolerance &&
      Math.abs(b.units - pattern[1]) <= tolerance;

    if (match(zeroPattern)) {
      bits += "0";
      matched += 1;
    } else if (match(onePattern)) {
      bits += "1";
      matched += 1;
    } else {
      bits += "?";
    }
  }

  return {
    bits,
    matched,
    totalPairs: pairs.length,
    ratio: pairs.length ? matched / pairs.length : 0,
  };
}

/**
 * @param {QuantizedEdge[]} frame
 * @returns {ProtocolRanking}
 */
function scoreEv1527Like(frame) {
  const stats = frameStats(frame);
  const decode = bitStringFromPairs(frame, [1, 3], [3, 1], 1);
  let score = 0;

  score += decode.ratio * 60;
  if (stats.length >= 16 && stats.length <= 80) score += 15;
  if (stats.alternating) score += 10;
  if (stats.big >= 1) score += 5;

  return {
    name: "ev1527_like",
    score,
    bits: decode.bits,
    details: `pairRatio=${decode.matched}/${decode.totalPairs}`,
  };
}

/**
 * @param {QuantizedEdge[]} frame
 * @returns {ProtocolRanking}
 */
function scorePt2262Like(frame) {
  const stats = frameStats(frame);
  const decode01 = bitStringFromPairs(frame, [1, 3], [3, 1], 1);
  const decodeTri = bitStringFromPairs(frame, [1, 1], [3, 3], 1);
  let score = 0;

  score += decode01.ratio * 35;
  score += decodeTri.ratio * 20;
  if (stats.length >= 12 && stats.length <= 96) score += 15;
  if (stats.alternating) score += 10;
  if (stats.unique >= 3 && stats.unique <= 6) score += 8;

  return {
    name: "pt2262_like",
    score,
    bits: decode01.bits,
    details: `01=${decode01.matched}/${decode01.totalPairs} tri=${decodeTri.matched}/${decodeTri.totalPairs}`,
  };
}

/**
 * @param {QuantizedEdge[]} frame
 * @returns {ProtocolRanking}
 */
function scorePwmGeneric(frame) {
  const stats = frameStats(frame);
  const pairs = pairsFromFrame(frame);
  let goodPairs = 0;

  for (const [a, b] of pairs) {
    if (!b) continue;
    const plausible =
      (a.units <= 2 && b.units >= 2 && b.units <= 8) ||
      (b.units <= 2 && a.units >= 2 && a.units <= 8);
    if (plausible) goodPairs += 1;
  }

  const ratio = pairs.length ? goodPairs / pairs.length : 0;
  let score = 0;

  score += ratio * 65;
  if (stats.alternating) score += 10;
  if (stats.length >= 12 && stats.length <= 80) score += 10;
  if (stats.unique >= 2 && stats.unique <= 6) score += 8;

  return {
    name: "generic_pwm",
    score,
    bits: null,
    details: `pairRatio=${goodPairs}/${pairs.length}`,
  };
}

/**
 * @param {QuantizedEdge[]} frame
 * @returns {ProtocolRanking}
 */
function scorePulseDistance(frame) {
  const stats = frameStats(frame);
  const pairs = pairsFromFrame(frame);
  let goodPairs = 0;

  for (const [a, b] of pairs) {
    if (!b) continue;
    const sum = a.units + b.units;
    const plausible =
      sum >= 3 &&
      sum <= 8 &&
      ((a.units <= 2 && b.units >= 1) || (b.units <= 2 && a.units >= 1));
    if (plausible) goodPairs += 1;
  }

  const ratio = pairs.length ? goodPairs / pairs.length : 0;
  let score = 0;

  score += ratio * 60;
  if (stats.alternating) score += 10;
  if (stats.big >= 1) score += 6;
  if (stats.length >= 12 && stats.length <= 80) score += 8;

  return {
    name: "pulse_distance_like",
    score,
    bits: null,
    details: `pairRatio=${goodPairs}/${pairs.length}`,
  };
}

/**
 * @param {QuantizedEdge[]} frame
 * @returns {ProtocolRanking[]}
 */
function rankProtocols(frame) {
  return [
    scoreEv1527Like(frame),
    scorePt2262Like(frame),
    scorePwmGeneric(frame),
    scorePulseDistance(frame),
  ].sort((a, b) => b.score - a.score);
}

/**
 * @param {QuantizedEdge[]} frame
 * @returns {QuantizedEdge[]}
 */
function trimLeadingSync(frame) {
  let start = 0;
  while (start < frame.length && frame[start].units >= 6) start += 1;
  return frame.slice(start);
}

/**
 * @param {QuantizedEdge[]} frame
 * @returns {QuantizedEdge[]}
 */
function trimTrailingOnes(frame) {
  let end = frame.length;
  while (end > 0 && frame[end - 1].units === 1) end -= 1;
  return frame.slice(0, end);
}

/**
 * @param {QuantizedEdge[]} frame
 * @param {[number, number]} zeroPattern
 * @param {[number, number]} onePattern
 * @param {number=} tolerance
 * @returns {{ bits: string, matched: number, totalPairs: number, ratio: number }}
 */
function decodePairs(frame, zeroPattern, onePattern, tolerance = 1) {
  const pairs = pairsFromFrame(frame);
  let bits = "";
  let matched = 0;

  for (const [a, b] of pairs) {
    if (!b) continue;

    const zeroMatch =
      Math.abs(a.units - zeroPattern[0]) <= tolerance &&
      Math.abs(b.units - zeroPattern[1]) <= tolerance;
    const oneMatch =
      Math.abs(a.units - onePattern[0]) <= tolerance &&
      Math.abs(b.units - onePattern[1]) <= tolerance;

    if (zeroMatch) {
      bits += "0";
      matched += 1;
    } else if (oneMatch) {
      bits += "1";
      matched += 1;
    } else {
      bits += "?";
    }
  }

  return {
    bits,
    matched,
    totalPairs: pairs.length,
    ratio: pairs.length ? matched / pairs.length : 0,
  };
}

/**
 * @param {QuantizedEdge[]} frame
 * @param {number=} tolerance
 * @returns {DecodedProtocolResult}
 */
function decodeEv1527Like(frame, tolerance = 1) {
  const trimmed = trimTrailingOnes(trimLeadingSync(frame));
  const decoded = decodePairs(trimmed, [1, 3], [3, 1], tolerance);
  const cleanBits = decoded.bits.replace(/\?/g, "");
  const maybe24 = cleanBits.length >= 24 ? cleanBits.slice(0, 24) : cleanBits;

  return {
    protocol: "ev1527_like",
    confidence: decoded.ratio,
    bits: decoded.bits,
    cleanBits,
    fields: maybe24.length >= 24 ? {
      id20: maybe24.slice(0, 20),
      button4: maybe24.slice(20, 24),
    } : null,
    details: `${decoded.matched}/${decoded.totalPairs} pairs matched`,
  };
}

/**
 * @param {QuantizedEdge[]} frame
 * @param {number=} tolerance
 * @returns {DecodedProtocolResult}
 */
function decodePt2262Like(frame, tolerance = 1) {
  const trimmed = trimTrailingOnes(trimLeadingSync(frame));
  const pairs = pairsFromFrame(trimmed);
  let symbols = "";
  let matched = 0;

  for (const [a, b] of pairs) {
    if (!b) continue;
    const is00 = Math.abs(a.units - 1) <= tolerance && Math.abs(b.units - 3) <= tolerance;
    const is11 = Math.abs(a.units - 3) <= tolerance && Math.abs(b.units - 1) <= tolerance;
    const isFloat = Math.abs(a.units - 1) <= tolerance && Math.abs(b.units - 1) <= tolerance;

    if (is00) {
      symbols += "0";
      matched += 1;
    } else if (is11) {
      symbols += "1";
      matched += 1;
    } else if (isFloat) {
      symbols += "F";
      matched += 1;
    } else {
      symbols += "?";
    }
  }

  return {
    protocol: "pt2262_like",
    confidence: pairs.length ? matched / pairs.length : 0,
    bits: symbols,
    cleanBits: symbols.replace(/\?/g, ""),
    fields: null,
    details: `${matched}/${pairs.length} symbols matched`,
  };
}

/**
 * @param {QuantizedEdge[]} frame
 * @param {number=} tolerance
 * @returns {DecodedProtocolResult}
 */
function decodeGenericPwm13(frame, tolerance = 1) {
  const trimmed = trimTrailingOnes(trimLeadingSync(frame));
  const decoded = decodePairs(trimmed, [1, 3], [1, 5], tolerance);

  return {
    protocol: "generic_pwm_13",
    confidence: decoded.ratio,
    bits: decoded.bits,
    cleanBits: decoded.bits.replace(/\?/g, ""),
    fields: null,
    details: `${decoded.matched}/${decoded.totalPairs} pairs matched`,
  };
}

/**
 * @param {QuantizedEdge[]} frame
 * @param {number=} tolerance
 * @returns {DecodedProtocolResult}
 */
function decodePulseDistanceLike(frame, tolerance = 1) {
  const trimmed = trimTrailingOnes(trimLeadingSync(frame));
  const pairs = pairsFromFrame(trimmed);
  let bits = "";
  let matched = 0;

  for (const [a, b] of pairs) {
    if (!b) continue;

    if (a.units <= 2 && b.units >= 2 && b.units <= 8) {
      bits += "0";
      matched += 1;
    } else if (b.units <= 2 && a.units >= 2 && a.units <= 8) {
      bits += "1";
      matched += 1;
    } else {
      bits += "?";
    }
  }

  return {
    protocol: "pulse_distance_like",
    confidence: pairs.length ? matched / pairs.length : 0,
    bits,
    cleanBits: bits.replace(/\?/g, ""),
    fields: null,
    details: `${matched}/${pairs.length} pairs matched`,
  };
}

/**
 * @param {string} protocol
 * @param {QuantizedEdge[]} frame
 * @param {number=} tolerance
 * @returns {DecodedProtocolResult}
 */
function decodeByProtocol(protocol, frame, tolerance = 1) {
  switch (protocol) {
    case "ev1527_like":
      return decodeEv1527Like(frame, tolerance);
    case "pt2262_like":
      return decodePt2262Like(frame, tolerance);
    case "generic_pwm_13":
      return decodeGenericPwm13(frame, tolerance);
    case "pulse_distance_like":
      return decodePulseDistanceLike(frame, tolerance);
    default:
      return {
        protocol,
        confidence: 0,
        bits: "",
        cleanBits: "",
        fields: null,
        details: "unknown protocol",
      };
  }
}

/**
 * @param {{ level: number, dtUs: number, wallclockMs: number }[]} edges
 * @param {{
 *   baseUs: number,
 *   minFrameEdges: number,
 *   maxFrameEdges: number,
 *   silenceUnits: number,
 *   maxFrames: number,
 *   niceSnap?: boolean
 * }} options
 * @returns {ProtocolCandidate[]}
 */
function detectProtocolCandidates(edges, options) {
  const quantized = quantizeEdges(edges, options.baseUs, options.niceSnap ?? true);

  return splitBySilence(quantized, options.silenceUnits)
    .filter((frame) => frame.length >= options.minFrameEdges)
    .filter((frame) => frame.length <= options.maxFrameEdges)
    .sort(
      (a, b) => scoreFrame(b, options.minFrameEdges, options.maxFrameEdges) -
        scoreFrame(a, options.minFrameEdges, options.maxFrameEdges)
    )
    .slice(0, options.maxFrames)
    .map((frame) => ({
      frame,
      frameScore: scoreFrame(frame, options.minFrameEdges, options.maxFrameEdges),
      rankings: rankProtocols(frame),
    }));
}

module.exports = {
  compactFrame,
  decodeByProtocol,
  decodeEv1527Like,
  decodeGenericPwm13,
  decodePt2262Like,
  decodePulseDistanceLike,
  detectProtocolCandidates,
  frameStats,
  quantizeEdges,
  rankProtocols,
  renderBars,
  roundToNiceTiming,
  scoreFrame,
  splitBySilence,
};
