// @ts-check

const { estimateBaseUnit, median } = require("./raw-analysis");

/**
 * @typedef {object} BurstEdge
 * @property {number} level
 * @property {number} dtUs
 *
 * @typedef {BurstEdge & {
 *   units: number,
 *   isGap: boolean,
 * }} BurstToken
 *
 * @typedef {object} NormalizedBurst
 * @property {number} baseUnitUs
 * @property {BurstToken[]} normalized
 *
 * @typedef {object} BurstAlignment
 * @property {number} offset
 * @property {number} score
 * @property {number} overlap
 * @property {BurstToken[]} matched
 * @property {number} aStart
 * @property {number} bStart
 */

/**
 * @param {BurstEdge[]} edges
 * @param {number | null=} fixedBaseUnitUs
 * @param {number=} maxDataUnits
 * @returns {NormalizedBurst | null}
 */
function normalizeBurst(edges, fixedBaseUnitUs = null, maxDataUnits = 15) {
  const durations = edges.map((edge) => edge.dtUs).filter((duration) => duration >= 80);
  if (durations.length < 8) return null;

  const baseUnitUs = fixedBaseUnitUs ?? estimateBaseUnit(durations);
  const normalized = edges
    .filter((edge) => edge.dtUs >= 80)
    .map((edge) => ({
      level: edge.level,
      dtUs: edge.dtUs,
      units: Math.max(1, Math.round(edge.dtUs / baseUnitUs)),
      isGap: false,
    }))
    .map((token) => ({
      ...token,
      isGap: token.units > maxDataUnits,
    }));

  return {
    baseUnitUs,
    normalized,
  };
}

/**
 * @param {BurstToken[]} tokens
 * @returns {BurstToken[]}
 */
function trimNoise(tokens) {
  let start = 0;
  let end = tokens.length - 1;

  while (start < tokens.length && (tokens[start].isGap || tokens[start].units === 1)) {
    start += 1;
  }

  while (end >= 0 && (tokens[end].isGap || tokens[end].units === 1)) {
    end -= 1;
  }

  if (start > end) return [];
  return tokens.slice(start, end + 1);
}

/**
 * @param {BurstToken[]} tokens
 * @returns {BurstToken[][]}
 */
function splitIntoSubframes(tokens) {
  const frames = [];
  let current = [];

  for (const token of tokens) {
    if (token.isGap) {
      if (current.length >= 6) frames.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }

  if (current.length >= 6) frames.push(current);
  return frames;
}

/**
 * @param {BurstToken[]} tokens
 * @returns {string}
 */
function tokenString(tokens) {
  return tokens.map((token) => `${token.level}:${token.units}`).join(" ");
}

/**
 * @param {Array<{ level: number, units: number }>} tokens
 * @returns {string}
 */
function compactTokenString(tokens) {
  return tokens.map((token) => {
    const bucket =
      token.units <= 1 ? "A" :
      token.units <= 3 ? "B" :
      token.units <= 6 ? "C" :
      token.units <= 10 ? "D" : "E";
    return `${token.level}${bucket}`;
  }).join("");
}

/**
 * @param {Array<{ level: number, units: number }>} tokens
 * @param {number=} maxBars
 * @returns {string}
 */
function renderTokenBars(tokens, maxBars = 100) {
  return tokens.slice(0, maxBars).map((token) => {
    const unit = token.units;
    if (unit <= 1) return token.level ? "▁" : "_";
    if (unit <= 2) return token.level ? "▂" : "_";
    if (unit <= 3) return token.level ? "▃" : "_";
    if (unit <= 5) return token.level ? "▄" : "_";
    if (unit <= 8) return token.level ? "▅" : "_";
    if (unit <= 12) return token.level ? "▆" : "_";
    return token.level ? "▇" : "_";
  }).join("");
}

/**
 * @param {{ level: number, units: number }} a
 * @param {{ level: number, units: number }} b
 * @param {number=} tolerance
 * @returns {boolean}
 */
function tokensMatch(a, b, tolerance = 1) {
  return a.level === b.level && Math.abs(a.units - b.units) <= tolerance;
}

/**
 * @param {BurstToken[]} a
 * @param {BurstToken[]} b
 * @param {number=} tolerance
 * @param {number=} minWindow
 * @returns {BurstAlignment | null}
 */
function bestWindowAlignment(a, b, tolerance = 1, minWindow = 8) {
  /** @type {BurstAlignment | null} */
  let best = null;

  for (let offset = -b.length + 1; offset < a.length; offset += 1) {
    let score = 0;
    let overlap = 0;
    /** @type {BurstToken[]} */
    const matched = [];
    let firstA = null;
    let firstB = null;

    for (let i = 0; i < a.length; i += 1) {
      const j = i - offset;
      if (j < 0 || j >= b.length) continue;
      overlap += 1;

      if (tokensMatch(a[i], b[j], tolerance)) {
        score += 1;
        matched.push(a[i]);
        if (firstA === null) {
          firstA = i;
          firstB = j;
        }
      }
    }

    if (overlap < minWindow) continue;

    const candidate = {
      offset,
      score,
      overlap,
      matched,
      aStart: firstA ?? 0,
      bStart: firstB ?? 0,
    };

    if (
      !best ||
      candidate.score > best.score ||
      (candidate.score === best.score && candidate.overlap > best.overlap)
    ) {
      best = candidate;
    }
  }

  return best;
}

/**
 * @param {BurstToken[]} tokens
 * @param {number=} tolerance
 * @param {number=} minWindow
 * @returns {(BurstAlignment & { split: number }) | null}
 */
function repeatedCore(tokens, tolerance = 1, minWindow = 8) {
  if (tokens.length < minWindow * 2) return null;

  let best = null;

  for (let split = minWindow; split <= tokens.length - minWindow; split += 1) {
    const left = tokens.slice(0, split);
    const right = tokens.slice(split);
    const match = bestWindowAlignment(left, right, tolerance, minWindow);
    if (!match) continue;

    if (
      !best ||
      match.score > best.score ||
      (match.score === best.score && match.overlap > best.overlap)
    ) {
      best = {
        ...match,
        split,
      };
    }
  }

  return best;
}

/**
 * @param {BurstToken[]} a
 * @param {BurstToken[]} b
 * @param {BurstAlignment} alignment
 * @param {number=} tolerance
 * @returns {Array<{ level: number, units: number }>}
 */
function extractSharedWindow(a, b, alignment, tolerance = 1) {
  /** @type {Array<{ level: number, units: number }>} */
  const shared = [];

  for (let i = 0; i < a.length; i += 1) {
    const j = i - alignment.offset;
    if (j < 0 || j >= b.length) continue;
    if (tokensMatch(a[i], b[j], tolerance)) {
      shared.push({
        level: a[i].level,
        units: Math.round((a[i].units + b[j].units) / 2),
      });
    }
  }

  return shared;
}

/**
 * @param {Array<{ level: number, units: number }>} tokensAtPosition
 * @returns {{ level: number, units: number } | null}
 */
function medianToken(tokensAtPosition) {
  if (!tokensAtPosition.length) return null;
  const levelVotes = tokensAtPosition.map((token) => token.level);
  const ones = levelVotes.filter((value) => value === 1).length;
  const zeros = levelVotes.length - ones;
  const level = ones >= zeros ? 1 : 0;
  const units = median(tokensAtPosition.map((token) => token.units));
  if (units === 0) return null;
  return { level, units };
}

/**
 * @param {Array<{ level: number, units: number }>} seed
 * @param {Array<{ tokens: BurstToken[], alignment: BurstAlignment | { offset: number } }>} alignedCandidates
 * @param {number=} tolerance
 * @returns {Array<{ level: number, units: number }>}
 */
function buildCanonicalFrame(seed, alignedCandidates, tolerance = 1) {
  if (!seed.length) return [];

  const columns = seed.map((token) => [token]);

  for (const candidate of alignedCandidates) {
    for (let i = 0; i < seed.length; i += 1) {
      const j = i - candidate.alignment.offset;
      if (j < 0 || j >= candidate.tokens.length) continue;
      if (tokensMatch(seed[i], candidate.tokens[j], tolerance)) {
        columns[i].push(candidate.tokens[j]);
      }
    }
  }

  return columns.map((column) => medianToken(column)).filter(Boolean);
}

module.exports = {
  bestWindowAlignment,
  buildCanonicalFrame,
  compactTokenString,
  extractSharedWindow,
  normalizeBurst,
  renderTokenBars,
  repeatedCore,
  splitIntoSubframes,
  tokenString,
  tokensMatch,
  trimNoise,
};
