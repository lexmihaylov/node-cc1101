// @ts-check

const { Gpio } = require("pigpio");
const { CC1101Driver } = require("../driver");
const { BAND, MODULATION, RADIO_MODE } = require("../profiles");
const { sleep } = require("../utils");
const {
  bestWindowAlignment,
  compactTokenString,
  normalizeBurst,
  renderTokenBars,
  repeatedCore,
  splitIntoSubframes,
  tokenString,
  trimNoise,
} = require("./burst-analysis");

/**
 * @typedef {import("./burst-analysis").BurstEdge} BurstEdge
 * @typedef {import("./burst-analysis").BurstToken} BurstToken
 *
 * @typedef {object} BurstMatchResult
 * @property {number} id
 * @property {string} ts
 * @property {string} reason
 * @property {BurstEdge[]} edges
 * @property {number} baseUnitUs
 * @property {BurstToken[]} tokens
 * @property {BurstToken[][]} subframes
 * @property {ReturnType<typeof repeatedCore>} core
 * @property {{ previousId: number, offset: number, score: number, overlap: number, matched: BurstToken[] } | null} bestPrevious
 *
 * @typedef {object} BurstMatcherOptions
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
 * @property {(message: string) => void=} onMessage
 * @property {(result: BurstMatchResult) => void=} onBurst
 */

class CC1101BurstMatcher {
  /**
   * @param {BurstMatcherOptions=} options
   */
  constructor(options = {}) {
    this.options = {
      bus: options.bus ?? 0,
      device: options.device ?? 0,
      speedHz: options.speedHz ?? 100000,
      gpio: options.gpio ?? 24,
      silenceGapUs: options.silenceGapUs ?? 10000,
      minEdges: options.minEdges ?? 16,
      maxRecent: options.maxRecent ?? 30,
      tolerance: options.tolerance ?? 1,
      baseUnitUs: options.baseUnitUs ?? null,
      maxDataUnits: options.maxDataUnits ?? 15,
      minWindow: options.minWindow ?? 8,
      onMessage: options.onMessage ?? ((message) => console.log(message)),
      onBurst: options.onBurst ?? ((result) => {
        this.options.onMessage("---- burst ----");
        this.options.onMessage(`id:         ${result.id}`);
        this.options.onMessage(`ts:         ${result.ts}`);
        this.options.onMessage(`edges:      ${result.edges.length}`);
        this.options.onMessage(`baseUnit:   ~${result.baseUnitUs} us`);
        this.options.onMessage(`tokens:     ${tokenString(result.tokens)}`);
        this.options.onMessage(`compact:    ${compactTokenString(result.tokens)}`);
        this.options.onMessage(`bars:       ${renderTokenBars(result.tokens)}`);
        this.options.onMessage("");

        result.subframes.forEach((subframe, index) => {
          this.options.onMessage(`subframe ${index + 1}: ${tokenString(subframe)}`);
          this.options.onMessage(`compact ${index + 1}:  ${compactTokenString(subframe)}`);
        });
        if (result.subframes.length) this.options.onMessage("");

        if (result.core) {
          this.options.onMessage("---- repeated core ----");
          this.options.onMessage(`split:      ${result.core.split}`);
          this.options.onMessage(`score:      ${result.core.score}/${result.core.overlap}`);
          this.options.onMessage(`core:       ${tokenString(result.core.matched)}`);
          this.options.onMessage(`compact:    ${compactTokenString(result.core.matched)}`);
          this.options.onMessage("");
        }

        if (result.bestPrevious) {
          this.options.onMessage("---- best previous match ----");
          this.options.onMessage(`current:    burst #${result.id}`);
          this.options.onMessage(`previous:   burst #${result.bestPrevious.previousId}`);
          this.options.onMessage(`offset:     ${result.bestPrevious.offset}`);
          this.options.onMessage(`score:      ${result.bestPrevious.score}/${result.bestPrevious.overlap}`);
          this.options.onMessage(`shared:     ${tokenString(result.bestPrevious.matched)}`);
          this.options.onMessage(`compact:    ${compactTokenString(result.bestPrevious.matched)}`);
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
    /** @type {BurstMatchResult[]} */
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

    /** @type {BurstMatchResult} */
    const result = {
      id: ++this.burstId,
      ts: new Date().toISOString(),
      reason,
      edges: [...this.currentBurst],
      baseUnitUs: normalized.baseUnitUs,
      tokens,
      subframes: splitIntoSubframes(tokens),
      core: repeatedCore(tokens, this.options.tolerance, this.options.minWindow),
      bestPrevious: null,
    };

    this.currentBurst = [];

    let best = null;
    let bestPrevious = null;
    for (const previous of this.recentBursts) {
      const match = bestWindowAlignment(result.tokens, previous.tokens, this.options.tolerance, this.options.minWindow);
      if (!match) continue;
      if (!best || match.score > best.score || (match.score === best.score && match.overlap > best.overlap)) {
        best = match;
        bestPrevious = previous;
      }
    }

    if (best && bestPrevious && best.score >= this.options.minWindow) {
      result.bestPrevious = {
        previousId: bestPrevious.id,
        offset: best.offset,
        score: best.score,
        overlap: best.overlap,
        matched: best.matched,
      };
    }

    this.recentBursts.push(result);
    if (this.recentBursts.length > this.options.maxRecent) {
      this.recentBursts.shift();
    }

    this.options.onBurst(result);
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

    this.radio = new CC1101Driver({
      bus: this.options.bus,
      device: this.options.device,
      speedHz: this.options.speedHz,
    });
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
      `burst matcher started gpio=${this.options.gpio} silenceGapUs=${this.options.silenceGapUs} minEdges=${this.options.minEdges} baseUnitUs=${this.options.baseUnitUs ?? "auto"}`
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
  CC1101BurstMatcher,
};
