// @ts-check

const { Gpio } = require("pigpio");
const { CC1101Driver } = require("../driver");
const { STATUS } = require("../constants");
const { BAND, MODULATION, RADIO_MODE } = require("../profiles");
const { sleep } = require("../utils");
const { renderSignalSummary } = require("./signal-renderer");
const {
  bestAlignment,
  buildConsensus,
  compactFrame,
  quantizeEdges,
  scoreFrame,
  splitBySilence,
  trimHistory,
} = require("./signal-analysis");

/**
 * @typedef {import("./signal-analysis").QuantizedSignalEdge} QuantizedSignalEdge
 *
 * @typedef {object} FrameStabilizerResult
 * @property {number} id
 * @property {string} ts
 * @property {number} triggerRssi
 * @property {QuantizedSignalEdge[]} bestFrame
 * @property {number} bestScore
 * @property {{ previousPressId: number, shift: number, score: number, overlap: number, ratio: number, matched: Array<{ level: number, units: number }> } | null} bestMatch
 * @property {Array<{ level: number, units: number }>} consensus
 * @property {number} sourceCount
 *
 * @typedef {object} FrameStabilizerOptions
 * @property {number=} bus
 * @property {number=} device
 * @property {number=} speedHz
 * @property {number=} gdo0
 * @property {number=} threshold
 * @property {number=} baseUs
 * @property {number=} historyMs
 * @property {number=} lookbackMs
 * @property {number=} settleMs
 * @property {number=} cooldownMs
 * @property {number=} pollMs
 * @property {number=} minDtUs
 * @property {number=} minFrameEdges
 * @property {number=} maxFrameEdges
 * @property {number=} silenceUnits
 * @property {boolean=} niceSnap
 * @property {number=} tolerance
 * @property {number=} maxShift
 * @property {number=} recentPresses
 * @property {(message: string) => void=} onMessage
 * @property {(result: FrameStabilizerResult) => void=} onFrame
 */

class CC1101FrameStabilizer {
  /**
   * @param {FrameStabilizerOptions=} options
   */
  constructor(options = {}) {
    this.options = {
      bus: options.bus ?? 0,
      device: options.device ?? 0,
      speedHz: options.speedHz ?? 100000,
      gdo0: options.gdo0 ?? 24,
      threshold: options.threshold ?? 100,
      baseUs: options.baseUs ?? 500,
      historyMs: options.historyMs ?? 2500,
      lookbackMs: options.lookbackMs ?? 1000,
      settleMs: options.settleMs ?? 1000,
      cooldownMs: options.cooldownMs ?? 500,
      pollMs: options.pollMs ?? 5,
      minDtUs: options.minDtUs ?? 20,
      minFrameEdges: options.minFrameEdges ?? 12,
      maxFrameEdges: options.maxFrameEdges ?? 60,
      silenceUnits: options.silenceUnits ?? 8,
      niceSnap: options.niceSnap ?? true,
      tolerance: options.tolerance ?? 1,
      maxShift: options.maxShift ?? 10,
      recentPresses: options.recentPresses ?? 12,
      onMessage: options.onMessage ?? ((message) => console.log(message)),
      onFrame: options.onFrame ?? ((result) => {
        const units = result.bestFrame.map((edge) => edge.units);
        this.options.onMessage("---- best frame ----");
        this.options.onMessage(`press:        ${result.id}`);
        this.options.onMessage(`ts:           ${result.ts}`);
        this.options.onMessage(`triggerRSSI:  ${result.triggerRssi}`);
        this.options.onMessage(`score:        ${result.bestScore}`);
        this.options.onMessage(`edges:        ${result.bestFrame.length}`);
        this.options.onMessage(`units:        ${units.join(",")}`);
        this.options.onMessage(`compact:      ${compactFrame(result.bestFrame)}`);
        for (const line of renderSignalSummary({
          label: "best",
          units,
          levels: result.bestFrame.map((edge) => edge.level),
          durationsUs: result.bestFrame.map((edge) => edge.dtUs),
          snappedUs: result.bestFrame.map((edge) => edge.snappedUs),
        })) {
          this.options.onMessage(line);
        }
        this.options.onMessage("");

        if (result.bestMatch) {
          this.options.onMessage("---- best match ----");
          this.options.onMessage(`previousPress:${result.bestMatch.previousPressId}`);
          this.options.onMessage(`shift:        ${result.bestMatch.shift}`);
          this.options.onMessage(`score:        ${result.bestMatch.score}/${result.bestMatch.overlap} (${(result.bestMatch.ratio * 100).toFixed(1)}%)`);
          this.options.onMessage(`matchedUnits: ${result.bestMatch.matched.map((token) => token.units).join(",")}`);
          for (const line of renderSignalSummary({
            label: "match",
            units: result.bestMatch.matched.map((token) => token.units),
            levels: result.bestMatch.matched.map((token) => token.level),
          })) {
            this.options.onMessage(line);
          }
          this.options.onMessage("");
        }

        if (result.consensus.length) {
          this.options.onMessage("---- consensus frame ----");
          this.options.onMessage(`sources:      ${result.sourceCount}`);
          this.options.onMessage(`units:        ${result.consensus.map((token) => token.units).join(",")}`);
          this.options.onMessage(`compact:      ${compactFrame(result.consensus)}`);
          for (const line of renderSignalSummary({
            label: "consensus",
            units: result.consensus.map((token) => token.units),
            levels: result.consensus.map((token) => token.level),
          })) {
            this.options.onMessage(line);
          }
          this.options.onMessage("");
        }
      }),
    };

    this.radio = null;
    this.gdo0Pin = null;
    this.loopPromise = null;
    this.stopping = false;
    this.lastTick = 0;
    this.pressId = 0;
    this.cooldownUntil = 0;
    this.pendingTrigger = null;
    this.edges = [];
    /** @type {Array<{ pressId: number, tokens: Array<{ level: number, units: number }> }>} */
    this.recentBestFrames = [];
  }

  async getRssiRaw() {
    if (!this.radio) throw new Error("Frame stabilizer radio is not initialized");
    return this.radio.readRegister(STATUS.RSSI);
  }

  handleAlert(level, tick) {
    if (this.stopping) {
      this.lastTick = tick;
      return;
    }
    if (this.lastTick === 0) {
      this.lastTick = tick;
      return;
    }
    let dtUs = tick - this.lastTick;
    if (dtUs < 0) dtUs += 0x100000000;
    this.lastTick = tick;
    if (dtUs < this.options.minDtUs) return;
    this.edges.push({ level, dtUs, wallclockMs: Date.now() });
    trimHistory(this.edges, this.options.historyMs);
  }

  async start() {
    if (this.loopPromise) return;
    this.stopping = false;
    this.lastTick = 0;
    this.pressId = 0;
    this.cooldownUntil = 0;
    this.pendingTrigger = null;
    this.edges = [];
    this.recentBestFrames = [];

    this.radio = new CC1101Driver({ bus: this.options.bus, device: this.options.device, speedHz: this.options.speedHz });
    this.gdo0Pin = new Gpio(this.options.gdo0, { mode: Gpio.INPUT, alert: true });

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
      `frame stabilizer started gdo0=${this.options.gdo0} threshold=${this.options.threshold} baseUs=${this.options.baseUs} lookbackMs=${this.options.lookbackMs} settleMs=${this.options.settleMs}`
    );

    this.gdo0Pin.on("alert", (level, tick) => this.handleAlert(level, tick));
    this.loopPromise = this.runLoop().finally(() => {
      this.loopPromise = null;
    });
  }

  async runLoop() {
    while (!this.stopping) {
      const now = Date.now();
      const rssi = await this.getRssiRaw().catch(() => null);

      if (!this.pendingTrigger && now >= this.cooldownUntil && rssi !== null && rssi < this.options.threshold) {
        this.pendingTrigger = { triggerTimeMs: now, triggerRssi: rssi };
        this.options.onMessage(`trigger rssi=${rssi}`);
      }

      if (this.pendingTrigger && now - this.pendingTrigger.triggerTimeMs >= this.options.settleMs) {
        const relevant = this.edges.filter((edge) => edge.wallclockMs >= this.pendingTrigger.triggerTimeMs - this.options.lookbackMs);
        if (relevant.length >= this.options.minFrameEdges) {
          const quantized = quantizeEdges(relevant, this.options.baseUs, this.options.niceSnap);
          const candidates = splitBySilence(quantized, this.options.silenceUnits)
            .filter((frame) => frame.length >= this.options.minFrameEdges)
            .sort((a, b) => scoreFrame(b, this.options.minFrameEdges, this.options.maxFrameEdges) - scoreFrame(a, this.options.minFrameEdges, this.options.maxFrameEdges));

          if (candidates.length) {
            const bestFrame = candidates[0];
            const bestScore = scoreFrame(bestFrame, this.options.minFrameEdges, this.options.maxFrameEdges);
            const bestTokens = bestFrame.map((edge) => ({ level: edge.level, units: edge.units }));
            let bestMatch = null;
            let bestMatchPressId = null;

            for (const previous of this.recentBestFrames) {
              const match = bestAlignment(bestTokens, previous.tokens, this.options.tolerance, this.options.maxShift);
              if (!bestMatch || match.score > bestMatch.score || (match.score === bestMatch.score && match.ratio > bestMatch.ratio)) {
                bestMatch = match;
                bestMatchPressId = previous.pressId;
              }
            }

            this.recentBestFrames.push({ pressId: this.pressId + 1, tokens: bestTokens });
            if (this.recentBestFrames.length > this.options.recentPresses) {
              this.recentBestFrames.shift();
            }

            const consensus = this.recentBestFrames.length >= 3
              ? buildConsensus(
                  this.recentBestFrames.map((entry) => entry.tokens),
                  this.options.tolerance
                )
              : [];

            this.options.onFrame({
              id: ++this.pressId,
              ts: new Date().toISOString(),
              triggerRssi: this.pendingTrigger.triggerRssi,
              bestFrame,
              bestScore,
              bestMatch: bestMatch && bestMatchPressId !== null && bestMatch.score >= Math.max(6, Math.floor(bestTokens.length * 0.35))
                ? {
                    previousPressId: bestMatchPressId,
                    shift: bestMatch.shift,
                    score: bestMatch.score,
                    overlap: bestMatch.overlap,
                    ratio: bestMatch.ratio,
                    matched: bestMatch.matched,
                  }
                : null,
              consensus,
              sourceCount: this.recentBestFrames.length,
            });
          }
        }

        this.pendingTrigger = null;
        this.cooldownUntil = now + this.options.cooldownMs;
      }

      await sleep(this.options.pollMs);
    }
  }

  async stop() {
    this.stopping = true;
    if (this.gdo0Pin) {
      try {
        this.gdo0Pin.disableAlert();
      } catch {}
      this.gdo0Pin = null;
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
  CC1101FrameStabilizer,
};
