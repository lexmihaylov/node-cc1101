// @ts-check

const { Gpio } = require("pigpio");
const { CC1101Driver } = require("../driver");
const { STATUS } = require("../constants");
const { BAND, MODULATION, RADIO_MODE } = require("../profiles");
const { sleep } = require("../utils");
const { shouldAcceptTriggerRssi } = require("./rssi-filter");
const { renderSignalSummary } = require("./signal-renderer");
const {
  buildConsensus,
  buildSlice,
  compactTokens,
  matchMask,
  quantizeEdges,
  smoothQuantizedEdges,
  trimHistory,
} = require("./signal-analysis");

/**
 * @typedef {import("./signal-analysis").ConsensusToken} ConsensusToken
 *
 * @typedef {ReturnType<typeof buildSlice>} WindowConsensusSlice
 *
 * @typedef {object} WindowConsensusPress
 * @property {number} pressId
 * @property {number} triggerRssi
 * @property {WindowConsensusSlice} slice
 *
 * @typedef {object} WindowConsensusResult
 * @property {WindowConsensusPress} press
 * @property {ConsensusToken[]} consensus
 * @property {WindowConsensusPress[]} recentSlices
 * @property {number} baseUs
 * @property {number} beforeMs
 * @property {number} afterMs
 * @property {number | null} sliceStart
 * @property {number | null} sliceEnd
 *
 * @typedef {object} WindowConsensusOptions
 * @property {number=} bus
 * @property {number=} device
 * @property {number=} speedHz
 * @property {number=} gdo0
 * @property {number=} threshold
 * @property {number=} baseUs
 * @property {number=} beforeMs
 * @property {number=} afterMs
 * @property {number=} historyMs
 * @property {number=} cooldownMs
 * @property {number=} pollMs
 * @property {number=} minDtUs
 * @property {boolean=} niceSnap
 * @property {boolean=} smoothUnits
 * @property {number=} tolerance
 * @property {number=} keepPresses
 * @property {number | null=} rssiTolerance
 * @property {number | null=} sliceStart
 * @property {number | null=} sliceEnd
 * @property {(message: string) => void=} onMessage
 * @property {(result: WindowConsensusResult) => void=} onConsensus
 */
class CC1101WindowConsensus {
  /**
   * @param {WindowConsensusOptions=} options
   */
  constructor(options = {}) {
    this.options = {
      bus: options.bus ?? 0,
      device: options.device ?? 0,
      speedHz: options.speedHz ?? 100000,
      gdo0: options.gdo0 ?? 24,
      threshold: options.threshold ?? 100,
      baseUs: options.baseUs ?? 400,
      beforeMs: options.beforeMs ?? 1000,
      afterMs: options.afterMs ?? 1000,
      historyMs: options.historyMs ?? Math.max(4000, (options.beforeMs ?? 1000) + (options.afterMs ?? 1000) + 1000),
      cooldownMs: options.cooldownMs ?? 1000,
      pollMs: options.pollMs ?? 5,
      minDtUs: options.minDtUs ?? 80,
      niceSnap: options.niceSnap ?? true,
      smoothUnits: options.smoothUnits ?? true,
      tolerance: options.tolerance ?? 1,
      keepPresses: options.keepPresses ?? 10,
      rssiTolerance: options.rssiTolerance ?? null,
      sliceStart: options.sliceStart ?? null,
      sliceEnd: options.sliceEnd ?? null,
      onMessage: options.onMessage ?? ((message) => console.log(message)),
      onConsensus: options.onConsensus ?? ((result) => {
        this.options.onMessage("============================================================");
        this.options.onMessage(`PRESS ${result.press.pressId}   ts=${new Date().toISOString()}   triggerRSSI=${result.press.triggerRssi}`);
        this.options.onMessage(`baseUs=${result.baseUs}   beforeMs=${result.beforeMs}   afterMs=${result.afterMs}`);
        this.options.onMessage(`sliceRange=${result.sliceStart ?? 0}..${result.sliceEnd ?? (result.press.slice.length - 1)}   sliceEdges=${result.press.slice.length}`);
        this.options.onMessage("");
        this.options.onMessage("---- current slice ----");
        this.options.onMessage(`edges:        ${result.press.slice.length}`);
        this.options.onMessage(`levels:       ${result.press.slice.map((edge) => edge.level).join(",")}`);
        this.options.onMessage(`units:        ${result.press.slice.map((edge) => edge.units).join(",")}`);
        this.options.onMessage(`compact:      ${compactTokens(result.press.slice)}`);
        for (const line of renderSignalSummary({
          label: "slice",
          units: result.press.slice.map((edge) => edge.units),
          levels: result.press.slice.map((edge) => edge.level),
        })) {
          this.options.onMessage(line);
        }
        this.options.onMessage("");
        this.options.onMessage("---- running consensus ----");
        this.options.onMessage(`sources:      ${result.recentSlices.length}`);
        this.options.onMessage(`units:        ${result.consensus.map((edge) => (edge.units === null ? "?" : edge.units)).join(",")}`);
        this.options.onMessage(`compact:      ${compactTokens(result.consensus)}`);
        for (const line of renderSignalSummary({
          label: "consensus",
          units: result.consensus.map((edge) => edge.units),
          levels: result.consensus.map((edge) => edge.level),
        })) {
          this.options.onMessage(line);
        }
        this.options.onMessage(`matchMask:    ${matchMask(result.consensus)}`);
        this.options.onMessage("");
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
    /** @type {WindowConsensusPress[]} */
    this.recentSlices = [];
    this.lastAcceptedTriggerRssi = null;
  }

  async getRssiRaw() {
    if (!this.radio) throw new Error("Window consensus radio is not initialized");
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

    this.edges.push({
      level,
      dtUs,
      wallclockMs: Date.now(),
    });
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
    this.recentSlices = [];
    this.lastAcceptedTriggerRssi = null;

    this.radio = new CC1101Driver({
      bus: this.options.bus,
      device: this.options.device,
      speedHz: this.options.speedHz,
    });
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
      `window consensus started gdo0=${this.options.gdo0} threshold=${this.options.threshold} baseUs=${this.options.baseUs} beforeMs=${this.options.beforeMs} afterMs=${this.options.afterMs} minDtUs=${this.options.minDtUs} tolerance=${this.options.tolerance} rssiTolerance=${this.options.rssiTolerance ?? "off"}`
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
        if (!shouldAcceptTriggerRssi(this.lastAcceptedTriggerRssi, rssi, this.options.rssiTolerance)) {
          this.options.onMessage(
            `ignored rssi=${rssi} reference=${this.lastAcceptedTriggerRssi} tolerance=${this.options.rssiTolerance}`
          );
          this.cooldownUntil = now + 100;
          await sleep(this.options.pollMs);
          continue;
        }
        this.pendingTrigger = {
          triggerTimeMs: now,
          triggerRssi: rssi,
        };
        this.options.onMessage(`trigger rssi=${rssi}`);
      }

      if (this.pendingTrigger && now >= this.pendingTrigger.triggerTimeMs + this.options.afterMs) {
        const startMs = this.pendingTrigger.triggerTimeMs - this.options.beforeMs;
        const endMs = this.pendingTrigger.triggerTimeMs + this.options.afterMs;
        const windowEdges = this.edges.filter((edge) => edge.wallclockMs >= startMs && edge.wallclockMs <= endMs);
        let quantized = quantizeEdges(windowEdges, this.options.baseUs, this.options.niceSnap);
        if (this.options.smoothUnits) {
          quantized = smoothQuantizedEdges(quantized);
        }

        const slice = buildSlice(quantized, this.options.sliceStart, this.options.sliceEnd, this.options.smoothUnits);
        const press = {
          pressId: ++this.pressId,
          triggerRssi: this.pendingTrigger.triggerRssi,
          slice,
        };

        this.recentSlices.push(press);
        while (this.recentSlices.length > this.options.keepPresses) {
          this.recentSlices.shift();
        }

        const consensus = buildConsensus(
          this.recentSlices.map((entry) => entry.slice),
          this.options.tolerance
        );
        this.lastAcceptedTriggerRssi = press.triggerRssi;
        this.options.onConsensus({
          press,
          consensus,
          recentSlices: [...this.recentSlices],
          baseUs: this.options.baseUs,
          beforeMs: this.options.beforeMs,
          afterMs: this.options.afterMs,
          sliceStart: this.options.sliceStart,
          sliceEnd: this.options.sliceEnd,
        });

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
  CC1101WindowConsensus,
};
