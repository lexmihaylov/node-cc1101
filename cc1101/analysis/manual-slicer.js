// @ts-check

const { Gpio } = require("pigpio");
const { CC1101Driver } = require("../driver");
const { STATUS } = require("../constants");
const { BAND, MODULATION, RADIO_MODE } = require("../profiles");
const { sleep } = require("../utils");
const {
  compactTokens,
  quantizeEdges,
  renderBars,
  smoothQuantizedEdges,
  trimHistory,
} = require("./signal-analysis");

/**
 * @typedef {import("./signal-analysis").QuantizedSignalEdge} QuantizedSignalEdge
 *
 * @typedef {object} ManualSliceResult
 * @property {number} id
 * @property {string} ts
 * @property {number} triggerRssi
 * @property {number} baseUs
 * @property {number} beforeMs
 * @property {number} afterMs
 * @property {QuantizedSignalEdge[]} quantized
 * @property {number | null} sliceStart
 * @property {number | null} sliceEnd
 * @property {boolean} smoothUnits
 *
 * @typedef {object} ManualSlicerOptions
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
 * @property {number=} rowSize
 * @property {number | null=} sliceStart
 * @property {number | null=} sliceEnd
 * @property {(message: string) => void=} onMessage
 * @property {(result: ManualSliceResult) => void=} onSlice
 */

function compactSignal(edges, useSmooth = false) {
  return compactTokens(
    edges.map((edge) => ({
      level: edge.level,
      units: useSmooth ? (edge.smoothUnits ?? edge.units) : edge.units,
    }))
  );
}

class CC1101ManualSlicer {
  /**
   * @param {ManualSlicerOptions=} options
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
      rowSize: options.rowSize ?? 10,
      sliceStart: options.sliceStart ?? null,
      sliceEnd: options.sliceEnd ?? null,
      onMessage: options.onMessage ?? ((message) => console.log(message)),
      onSlice: options.onSlice ?? ((result) => {
        const units = result.quantized.map((edge) => edge.units);
        const smoothUnits = result.quantized.map((edge) => edge.smoothUnits ?? edge.units);
        const relMs = result.quantized.map((edge) => ((edge.wallclockMs - (result.quantized[0]?.wallclockMs ?? 0)) / 1000).toFixed(3));
        this.options.onMessage("============================================================");
        this.options.onMessage(`PRESS ${result.id}   ts=${result.ts}   triggerRSSI=${result.triggerRssi}`);
        this.options.onMessage(`baseUs=${result.baseUs}   beforeMs=${result.beforeMs}   afterMs=${result.afterMs}   totalEdges=${result.quantized.length}`);
        this.options.onMessage("");
        this.options.onMessage("---- full trigger window ----");
        this.options.onMessage(`edges:        ${result.quantized.length}`);
        this.options.onMessage(`levels:       ${result.quantized.map((edge) => edge.level).join(",")}`);
        this.options.onMessage(`durations:    ${result.quantized.map((edge) => edge.dtUs).join(",")}`);
        this.options.onMessage(`snappedUs:    ${result.quantized.map((edge) => edge.snappedUs).join(",")}`);
        this.options.onMessage(`units:        ${units.join(",")}`);
        if (result.smoothUnits) this.options.onMessage(`smoothUnits:  ${smoothUnits.join(",")}`);
        this.options.onMessage(`relTimeSec:   ${relMs.join(",")}`);
        this.options.onMessage(`compact:      ${compactSignal(result.quantized, false)}`);
        if (result.smoothUnits) this.options.onMessage(`smoothCmpct:  ${compactSignal(result.quantized, true)}`);
        this.options.onMessage(`bars:         ${renderBars(units, 160)}`);
        if (result.smoothUnits) this.options.onMessage(`smoothBars:   ${renderBars(smoothUnits, 160)}`);
        this.options.onMessage("");

        this.options.onMessage("---- indexed rows ----");
        for (let i = 0; i < result.quantized.length; i += this.options.rowSize) {
          const chunk = result.quantized.slice(i, i + this.options.rowSize);
          this.options.onMessage(`idx : ${chunk.map((edge) => String(edge.idx).padStart(3, " ")).join(" ")}`);
          this.options.onMessage(`lvl : ${chunk.map((edge) => String(edge.level).padStart(3, " ")).join(" ")}`);
          this.options.onMessage(`dur : ${chunk.map((edge) => String(edge.dtUs).padStart(4, " ")).join(" ")}`);
          this.options.onMessage(`snap: ${chunk.map((edge) => String(edge.snappedUs).padStart(4, " ")).join(" ")}`);
          this.options.onMessage(`unit: ${chunk.map((edge) => String(edge.units).padStart(3, " ")).join(" ")}`);
          if (result.smoothUnits) {
            this.options.onMessage(`smth: ${chunk.map((edge) => String(edge.smoothUnits ?? edge.units).padStart(3, " ")).join(" ")}`);
          }
          this.options.onMessage("");
        }

        this.options.onMessage("---- manual slice ----");
        if (result.sliceStart === null || result.sliceEnd === null) {
          this.options.onMessage("No manual slice selected. Use sliceStart and sliceEnd.");
          this.options.onMessage("");
          return;
        }

        const start = Math.max(0, result.sliceStart);
        const end = Math.min(result.quantized.length - 1, result.sliceEnd);
        if (start > end || result.quantized.length === 0) {
          this.options.onMessage("invalid slice");
          this.options.onMessage("");
          return;
        }

        const slice = result.quantized.slice(start, end + 1);
        const sliceUnits = slice.map((edge) => edge.units);
        const sliceSmoothUnits = slice.map((edge) => edge.smoothUnits ?? edge.units);
        this.options.onMessage(`range:        ${start}..${end}`);
        this.options.onMessage(`edges:        ${slice.length}`);
        this.options.onMessage(`levels:       ${slice.map((edge) => edge.level).join(",")}`);
        this.options.onMessage(`durations:    ${slice.map((edge) => edge.dtUs).join(",")}`);
        this.options.onMessage(`snappedUs:    ${slice.map((edge) => edge.snappedUs).join(",")}`);
        this.options.onMessage(`units:        ${sliceUnits.join(",")}`);
        if (result.smoothUnits) this.options.onMessage(`smoothUnits:  ${sliceSmoothUnits.join(",")}`);
        this.options.onMessage(`compact:      ${compactSignal(slice, false)}`);
        if (result.smoothUnits) this.options.onMessage(`smoothCmpct:  ${compactSignal(slice, true)}`);
        this.options.onMessage(`bars:         ${renderBars(sliceUnits)}`);
        if (result.smoothUnits) this.options.onMessage(`smoothBars:   ${renderBars(sliceSmoothUnits)}`);
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
  }

  async getRssiRaw() {
    if (!this.radio) throw new Error("Manual slicer radio is not initialized");
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
      `window slicer started gdo0=${this.options.gdo0} threshold=${this.options.threshold} baseUs=${this.options.baseUs} beforeMs=${this.options.beforeMs} afterMs=${this.options.afterMs} minDtUs=${this.options.minDtUs} smoothUnits=${this.options.smoothUnits}`
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

      if (this.pendingTrigger && now >= this.pendingTrigger.triggerTimeMs + this.options.afterMs) {
        const startMs = this.pendingTrigger.triggerTimeMs - this.options.beforeMs;
        const endMs = this.pendingTrigger.triggerTimeMs + this.options.afterMs;
        const windowEdges = this.edges.filter((edge) => edge.wallclockMs >= startMs && edge.wallclockMs <= endMs);
        let quantized = quantizeEdges(windowEdges, this.options.baseUs, this.options.niceSnap);
        if (this.options.smoothUnits) {
          quantized = smoothQuantizedEdges(quantized);
        }

        this.options.onSlice({
          id: ++this.pressId,
          ts: new Date().toISOString(),
          triggerRssi: this.pendingTrigger.triggerRssi,
          baseUs: this.options.baseUs,
          beforeMs: this.options.beforeMs,
          afterMs: this.options.afterMs,
          quantized,
          sliceStart: this.options.sliceStart,
          sliceEnd: this.options.sliceEnd,
          smoothUnits: this.options.smoothUnits,
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
  CC1101ManualSlicer,
};
