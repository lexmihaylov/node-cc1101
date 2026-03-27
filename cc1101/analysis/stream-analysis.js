// @ts-check

const path = require("path");
const {
  buildCanonicalFrame,
  bestWindowAlignment,
  extractSharedWindow,
  normalizeBurst,
  repeatedCore,
  tokensMatch,
  trimNoise,
} = require("./burst-analysis");
const {
  compactFrame,
  decodeByProtocol,
  quantizeEdges,
  rankProtocols,
} = require("./protocol-analysis");
const {
  estimateTimingGrid,
  renderBars,
  smoothQuantizedEdges,
} = require("./signal-analysis");
const { saveCaptureFile } = require("./capture-file");

/**
 * @typedef {object} StreamAnalysisOptions
 * @property {number=} baseUs
 * @property {number=} silenceUnits
 * @property {number=} minBurstEdges
 * @property {number=} tolerance
 * @property {number=} minClusterSize
 * @property {boolean=} niceSnap
 * @property {string=} exportPath
 *
 * @typedef {object} BurstCandidate
 * @property {number} index
 * @property {number} edgeCount
 * @property {number} tokenCount
 * @property {number} baseUnitUs
 * @property {Array<{ level: number, units: number }>} tokens
 * @property {string} compact
 * @property {string} bars
 * @property {{ name: string, score: number, bits: string | null, details: string }[]} rankings
 *
 * @typedef {object} ClusterSummary
 * @property {number} index
 * @property {number[]} burstIndexes
 * @property {number} size
 * @property {Array<{ level: number, units: number }>} frame
 * @property {string} compact
 * @property {string} bars
 * @property {ReturnType<typeof rankProtocols>} rankings
 * @property {ReturnType<typeof decodeByProtocol>} decoded
 *
 * @typedef {object} StreamAnalysisResult
 * @property {string} sourceType
 * @property {number} edgeCount
 * @property {number} burstCount
 * @property {{ baseUsRaw: number, baseUs: number, clustersUs: number[] }} timing
 * @property {BurstCandidate[]} bursts
 * @property {ClusterSummary[]} clusters
 * @property {ClusterSummary | null} best
 * @property {string | null} exportPath
 */

/**
 * @param {{ level: number, units: number }[]} tokens
 * @param {number} baseUs
 * @returns {Array<{ level: number, dtUs: number, wallclockMs: number }>}
 */
function tokensToEdges(tokens, baseUs) {
  return tokens.map((token, index) => ({
    level: token.level,
    dtUs: token.units * baseUs,
    wallclockMs: index,
  }));
}

/**
 * @param {Array<{ units: number, dtUs: number }>} quantized
 * @param {number} baseUs
 * @param {number} silenceUnits
 * @returns {any[][]}
 */
function splitByRawSilence(quantized, baseUs, silenceUnits) {
  const frames = [];
  let current = [];

  for (const edge of quantized) {
    const rawUnits = Math.max(edge.units, Math.round(edge.dtUs / baseUs));
    if (rawUnits >= silenceUnits) {
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
 * @param {{ level: number, units: number }[]} a
 * @param {{ level: number, units: number }[]} b
 * @param {number} tolerance
 * @returns {boolean}
 */
function tokenArraysMatch(a, b, tolerance) {
  const alignment = bestWindowAlignment(
    a.map((token) => ({ ...token, dtUs: token.units, isGap: false })),
    b.map((token) => ({ ...token, dtUs: token.units, isGap: false })),
    tolerance,
    Math.min(8, Math.max(4, Math.min(a.length, b.length)))
  );

  if (!alignment) return false;
  const ratio = alignment.score / Math.max(1, alignment.overlap);
  return ratio >= 0.75;
}

/**
 * @param {{ level: number, units: number }[]} seed
 * @param {{ level: number, units: number }[]} candidate
 * @param {number} tolerance
 * @returns {{ offset: number } | null}
 */
function alignTokenArrays(seed, candidate, tolerance) {
  const alignment = bestWindowAlignment(
    seed.map((token) => ({ ...token, dtUs: token.units, isGap: false })),
    candidate.map((token) => ({ ...token, dtUs: token.units, isGap: false })),
    tolerance,
    Math.min(8, Math.max(4, Math.min(seed.length, candidate.length)))
  );

  if (!alignment) return null;
  const ratio = alignment.score / Math.max(1, alignment.overlap);
  if (ratio < 0.75) return null;
  return { offset: alignment.offset };
}

/**
 * @param {{ level: number, units: number }[]} tokens
 * @param {number} tolerance
 * @returns {{ level: number, units: number }[]}
 */
function extractStableCore(tokens, tolerance) {
  const core = repeatedCore(
    tokens.map((token) => ({ ...token, dtUs: token.units, isGap: false })),
    tolerance,
    Math.min(8, Math.max(4, Math.floor(tokens.length / 3)))
  );

  if (!core) return tokens;

  const left = tokens.slice(0, core.split);
  const right = tokens.slice(core.split);
  const shared = extractSharedWindow(
    left.map((token) => ({ ...token, dtUs: token.units, isGap: false })),
    right.map((token) => ({ ...token, dtUs: token.units, isGap: false })),
    core,
    tolerance
  );

  return shared.length >= 8 ? shared : tokens;
}

/**
 * @param {any} stream
 * @param {StreamAnalysisOptions=} options
 * @returns {StreamAnalysisResult}
 */
function analyzeRecordedStream(stream, options = {}) {
  const edges = Array.isArray(stream?.edges) ? stream.edges : [];
  const timing = estimateTimingGrid(edges.map((edge) => edge.dtUs));
  const baseUs = Number(options.baseUs ?? stream?.baseUs ?? timing.baseUs);
  const silenceUnits = Number(options.silenceUnits ?? 18);
  const minBurstEdges = Number(options.minBurstEdges ?? 8);
  const minStableTokens = Math.max(6, Math.floor(minBurstEdges * 0.6));
  const tolerance = Number(options.tolerance ?? 1);
  const minClusterSize = Number(options.minClusterSize ?? 2);

  const quantized = smoothQuantizedEdges(quantizeEdges(edges, baseUs, options.niceSnap ?? true));
  const rawBursts = splitByRawSilence(quantized, baseUs, silenceUnits)
    .filter((burst) => burst.length >= minBurstEdges);

  /** @type {BurstCandidate[]} */
  const bursts = [];

  for (let index = 0; index < rawBursts.length; index += 1) {
    const burst = rawBursts[index];
    const normalized = normalizeBurst(
      burst.map((edge) => ({ level: edge.level, dtUs: edge.dtUs })),
      baseUs
    );

    if (!normalized) continue;

    const trimmed = trimNoise(normalized.normalized)
      .filter((token) => !token.isGap)
      .map((token) => ({ level: token.level, units: token.units }));

    if (trimmed.length < minStableTokens) continue;

    const stable = extractStableCore(trimmed, tolerance);
    const frame = quantizeEdges(tokensToEdges(stable, baseUs), baseUs, false);

    bursts.push({
      index,
      edgeCount: burst.length,
      tokenCount: stable.length,
      baseUnitUs: normalized.baseUnitUs,
      tokens: stable,
      compact: stable.map((token) => `${token.level}:${token.units}`).join(" "),
      bars: renderBars(stable.map((token) => token.units)),
      rankings: rankProtocols(frame),
    });
  }

  /** @type {Array<{ burstIndexes: number[], seed: { level: number, units: number }[] }>} */
  const groups = [];

  for (const burst of bursts) {
    let group = groups.find((entry) => tokenArraysMatch(entry.seed, burst.tokens, tolerance));
    if (!group) {
      group = {
        burstIndexes: [],
        seed: burst.tokens,
      };
      groups.push(group);
    }
    group.burstIndexes.push(burst.index);
  }

  /** @type {ClusterSummary[]} */
  const clusters = groups
    .filter((group) => group.burstIndexes.length >= minClusterSize)
    .map((group, index) => {
      const seed = group.seed;
      const alignedCandidates = bursts
        .filter((burst) => group.burstIndexes.includes(burst.index))
        .map((burst) => ({
          tokens: burst.tokens.map((token) => ({ ...token, dtUs: token.units, isGap: false })),
          alignment: alignTokenArrays(seed, burst.tokens, tolerance) ?? { offset: 0 },
        }));

      const frame = buildCanonicalFrame(
        seed.map((token) => ({ ...token, dtUs: token.units, isGap: false })),
        alignedCandidates,
        tolerance
      );
      const rankedFrame = quantizeEdges(tokensToEdges(frame, baseUs), baseUs, false);
      const rankings = rankProtocols(rankedFrame);
      const decoded = decodeByProtocol(rankings[0]?.name ?? "unknown", rankedFrame, tolerance);

      return {
        index,
        burstIndexes: group.burstIndexes,
        size: group.burstIndexes.length,
        frame,
        compact: compactFrame(rankedFrame),
        bars: renderBars(frame.map((token) => token.units)),
        rankings,
        decoded,
      };
    })
    .sort((a, b) => b.size - a.size || (b.rankings[0]?.score ?? 0) - (a.rankings[0]?.score ?? 0));

  const best = clusters[0] ?? null;
  let exportPath = null;

  if (best && options.exportPath) {
    const exported = {
      type: "stable_frame",
      ts: new Date().toISOString(),
      sourceType: stream?.type ?? "unknown",
      sourceTs: stream?.ts ?? null,
      baseUs,
      edgeCount: best.frame.length,
      levels: best.frame.map((token) => token.level),
      durationsUs: best.frame.map((token) => token.units * baseUs),
      snappedUs: best.frame.map((token) => token.units * baseUs),
      units: best.frame.map((token) => token.units),
      edges: best.frame.map((token, idx) => ({
        idx,
        level: token.level,
        dtUs: token.units * baseUs,
        snappedUs: token.units * baseUs,
        units: token.units,
        wallclockMs: idx,
      })),
      protocol: best.rankings[0]?.name ?? null,
      protocolScore: best.rankings[0]?.score ?? null,
      decoded: best.decoded,
      clusterSize: best.size,
    };

    saveCaptureFile(options.exportPath, exported);
    exportPath = options.exportPath;
  }

  return {
    sourceType: stream?.type ?? "unknown",
    edgeCount: edges.length,
    burstCount: rawBursts.length,
    timing,
    bursts,
    clusters,
    best,
    exportPath,
  };
}

/**
 * @param {string} sourcePath
 * @returns {string}
 */
function buildStableFramePath(sourcePath) {
  const parsed = path.parse(sourcePath);
  return path.join(parsed.dir, `${parsed.name}.stable-frame.json`);
}

module.exports = {
  analyzeRecordedStream,
  buildStableFramePath,
};
