// @ts-check

const { Gpio } = require("pigpio");
const { CC1101Driver } = require("../driver");
const { BAND, MODULATION, RADIO_MODE } = require("../profiles");
const { sleep } = require("../utils");
const { renderSignalSummary } = require("./signal-renderer");
const {
  bestWindowAlignment,
  buildCanonicalFrame,
  compactTokenString,
  extractSharedWindow,
  normalizeBurst,
  splitIntoSubframes,
  tokenString,
  trimNoise,
} = require("./burst-analysis");

/**
 * @typedef {import("./burst-analysis").BurstEdge} BurstEdge
 * @typedef {import("./burst-analysis").BurstToken} BurstToken
 *
 * @typedef {object} CanonicalFrameResult
 * @property {number} id
 * @property {string} ts
 * @property {string} reason
 * @property {BurstEdge[]} edges
 * @property {number} baseUnitUs
 * @property {BurstToken[]} tokens
 * @property {BurstToken[][]} subframes
 * @property {{ previousId: number, offset: number, score: number, overlap: number, shared: Array<{ level: number, units: number }> } | null} bestPrevious
 * @property {Array<{ level: number, units: number }>} canonical
 * @property {string[]} canonicalSourceIds
 *
 * @typedef {object} CanonicalFrameOptions
 * @property {number=} bus
 * @property {number=} device
 * @property {number=} speedHz
 * @property {number=} gpio
 * @property {number=} silenceGapUs
 * @property {number=} minEdges
 * @property {number=} maxRecent
 * @property {number=} tolerance
 * @property {number | null=} baseUnitUs
 * @property {number=} maxDataUnits
 * @property {number=} minWindow
 * @property {number=} canonicalMinScore
 * @property {number=} canonicalMinSources
 * @property {(message: string) => void=} onMessage
 * @property {(result: CanonicalFrameResult) => void=} onFrame
 */

class CC1101CanonicalFrameBuilder {
  /**
   * @param {CanonicalFrameOptions=} options
   */
  constructor(options = {}) {
    this.options = {
      bus: options.bus ?? 0,
      device: options.device ?? 0,
      speedHz: options.speedHz ?? 100000,
      gpio: options.gpio ?? 24,
      silenceGapUs: options.silenceGapUs ?? 10000,
      minEdges: options.minEdges ?? 16,
      maxRecent: options.maxRecent ?? 40,
      tolerance: options.tolerance ?? 1,
      baseUnitUs: options.baseUnitUs ?? null,
      maxDataUnits: options.maxDataUnits ?? 15,
      minWindow: options.minWindow ?? 8,
      canonicalMinScore: options.canonicalMinScore ?? 12,
      canonicalMinSources: options.canonicalMinSources ?? 3,
      onMessage: options.onMessage ?? ((message) => console.log(message)),
      onFrame: options.onFrame ?? ((result) => {
        this.options.onMessage("---- burst ----");
        this.options.onMessage(`id:         ${result.id}`);
        this.options.onMessage(`ts:         ${result.ts}`);
        this.options.onMessage(`edges:      ${result.edges.length}`);
        this.options.onMessage(`baseUnit:   ~${result.baseUnitUs} us`);
        this.options.onMessage(`tokens:     ${tokenString(result.tokens)}`);
        this.options.onMessage(`compact:    ${compactTokenString(result.tokens)}`);
        for (const line of renderSignalSummary({
          label: "burst",
          units: result.tokens.map((token) => token.units),
          levels: result.tokens.map((token) => token.level),
        })) {
          this.options.onMessage(line);
        }
        this.options.onMessage("");

        result.subframes.forEach((subframe, index) => {
          this.options.onMessage(`subframe ${index + 1}: ${tokenString(subframe)}`);
          this.options.onMessage(`compact ${index + 1}:  ${compactTokenString(subframe)}`);
        });
        if (result.subframes.length) this.options.onMessage("");

        if (result.bestPrevious) {
          this.options.onMessage("---- best previous match ----");
          this.options.onMessage(`current:    burst #${result.id}`);
          this.options.onMessage(`previous:   burst #${result.bestPrevious.previousId}`);
          this.options.onMessage(`offset:     ${result.bestPrevious.offset}`);
          this.options.onMessage(`score:      ${result.bestPrevious.score}/${result.bestPrevious.overlap}`);
          this.options.onMessage(`shared:     ${tokenString(result.bestPrevious.shared)}`);
          this.options.onMessage(`compact:    ${compactTokenString(result.bestPrevious.shared)}`);
          for (const line of renderSignalSummary({
            label: "shared",
            units: result.bestPrevious.shared.map((token) => token.units),
            levels: result.bestPrevious.shared.map((token) => token.level),
          })) {
            this.options.onMessage(line);
          }
          this.options.onMessage("");
        }

        if (result.canonical.length) {
          this.options.onMessage("---- canonical frame ----");
          this.options.onMessage(`sources:    ${result.canonicalSourceIds.join(", ")}`);
          this.options.onMessage(`tokens:     ${tokenString(result.canonical)}`);
          this.options.onMessage(`compact:    ${compactTokenString(result.canonical)}`);
          for (const line of renderSignalSummary({
            label: "canon",
            units: result.canonical.map((token) => token.units),
            levels: result.canonical.map((token) => token.level),
          })) {
            this.options.onMessage(line);
          }
          this.options.onMessage("");
        }
      }),
    };

    this.radio = null;
    this.input = null;
    this.loopPromise = null;
    this.stopping = false;
    this.lastTick = 0;
    this.currentBurst = [];
    this.lastEdgeWallclock = Date.now();
    this.burstId = 0;
    /** @type {CanonicalFrameResult[]} */
    this.recentBursts = [];
  }

  finalizeBurst(reason = "gap") {
    if (this.currentBurst.length < this.options.minEdges) {
      this.currentBurst = [];
      return;
    }

    const normalized = normalizeBurst(this.currentBurst, this.options.baseUnitUs, this.options.maxDataUnits);
    if (!normalized) {
      this.currentBurst = [];
      return;
    }

    const tokens = trimNoise(normalized.normalized);
    if (tokens.length < this.options.minWindow) {
      this.currentBurst = [];
      return;
    }

    /** @type {CanonicalFrameResult} */
    const result = {
      id: ++this.burstId,
      ts: new Date().toISOString(),
      reason,
      edges: [...this.currentBurst],
      baseUnitUs: normalized.baseUnitUs,
      tokens,
      subframes: splitIntoSubframes(tokens),
      bestPrevious: null,
      canonical: [],
      canonicalSourceIds: [],
    };
    this.currentBurst = [];

    const goodMatches = [];
    for (const previous of this.recentBursts) {
      const alignment = bestWindowAlignment(result.tokens, previous.tokens, this.options.tolerance, this.options.minWindow);
      if (!alignment) continue;
      if (alignment.score < this.options.canonicalMinScore) continue;
      goodMatches.push({ burst: previous, alignment });
    }

    if (goodMatches.length) {
      const best = goodMatches.reduce((acc, cur) => {
        if (!acc) return cur;
        if (cur.alignment.score > acc.alignment.score) return cur;
        if (cur.alignment.score === acc.alignment.score && cur.alignment.overlap > acc.alignment.overlap) return cur;
        return acc;
      }, null);

      const shared = best ? extractSharedWindow(result.tokens, best.burst.tokens, best.alignment, this.options.tolerance) : [];
      if (best) {
        result.bestPrevious = {
          previousId: best.burst.id,
          offset: best.alignment.offset,
          score: best.alignment.score,
          overlap: best.alignment.overlap,
          shared,
        };
      }

      const canonicalSources = [
        { id: result.id, tokens: result.tokens, alignment: { offset: 0 } },
        ...goodMatches.slice(0, Math.min(goodMatches.length, 6)).map((match) => ({
          id: match.burst.id,
          tokens: match.burst.tokens,
          alignment: match.alignment,
        })),
      ];

      if (canonicalSources.length >= this.options.canonicalMinSources) {
        const seed = shared.length ? shared : result.tokens;
        result.canonical = buildCanonicalFrame(
          seed,
          canonicalSources.slice(1).map((source) => ({
            tokens: source.tokens,
            alignment: source.alignment,
          })),
          this.options.tolerance
        );
        result.canonicalSourceIds = canonicalSources.map((source) => `#${source.id}`);
      }
    }

    this.recentBursts.push(result);
    if (this.recentBursts.length > this.options.maxRecent) {
      this.recentBursts.shift();
    }

    this.options.onFrame(result);
  }

  handleAlert(level, tick) {
    if (this.stopping) {
      this.lastTick = tick;
      return;
    }
    if (this.lastTick === 0) {
      this.lastTick = tick;
      this.lastEdgeWallclock = Date.now();
      return;
    }

    let dtUs = tick - this.lastTick;
    if (dtUs < 0) dtUs += 0x100000000;
    this.lastTick = tick;

    if (dtUs >= this.options.silenceGapUs && this.currentBurst.length > 0) {
      this.finalizeBurst("silence-gap");
    }

    this.currentBurst.push({ level, dtUs });
    this.lastEdgeWallclock = Date.now();
  }

  async start() {
    if (this.loopPromise) return;
    this.stopping = false;
    this.lastTick = 0;
    this.currentBurst = [];
    this.lastEdgeWallclock = Date.now();
    this.burstId = 0;
    this.recentBursts = [];

    this.radio = new CC1101Driver({ bus: this.options.bus, device: this.options.device, speedHz: this.options.speedHz });
    this.input = new Gpio(this.options.gpio, { mode: Gpio.INPUT, alert: true });

    await this.radio.open();
    await this.radio.reset();
    await this.radio.verifyChip();
    await this.radio.startDirectAsyncRx({
      band: BAND.MHZ_433,
      modulation: MODULATION.OOK,
      mode: RADIO_MODE.DIRECT_ASYNC,
    });
    await sleep(100);

    this.options.onMessage(
      `canonical matcher started gpio=${this.options.gpio} silenceGapUs=${this.options.silenceGapUs} minEdges=${this.options.minEdges} baseUnitUs=${this.options.baseUnitUs ?? "auto"}`
    );

    this.input.on("alert", (level, tick) => this.handleAlert(level, tick));
    this.loopPromise = this.runLoop().finally(() => {
      this.loopPromise = null;
    });
  }

  async runLoop() {
    while (!this.stopping) {
      const now = Date.now();
      if (this.currentBurst.length > 0 && now - this.lastEdgeWallclock > Math.ceil(this.options.silenceGapUs / 1000)) {
        this.finalizeBurst("idle-gap");
      }
      await sleep(5);
    }
  }

  async stop() {
    this.stopping = true;
    try {
      this.finalizeBurst("shutdown");
    } catch {}
    if (this.input) {
      try {
        this.input.disableAlert();
      } catch {}
      this.input = null;
    }
    if (this.radio) {
      try {
        await this.radio.idle();
      } catch {}
      try {
        await this.radio.close();
      } catch {}
      this.radio = null;
    }
    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
    }
  }
}

module.exports = {
  CC1101CanonicalFrameBuilder,
};
