// @ts-check

const { Gpio } = require("pigpio");
const { CC1101Driver } = require("../driver");
const { STATUS } = require("../constants");
const { BAND, MODULATION, RADIO_MODE } = require("../profiles");
const { sleep } = require("../utils");
const { summarizeFrame } = require("./raw-analysis");
const { renderSignalSummary } = require("./signal-renderer");

/**
 * @typedef {import("./raw-analysis").RawFrame} RawFrame
 * @typedef {import("./raw-analysis").RawFrameSummary} RawFrameSummary
 *
 * @typedef {object} RawListenerOptions
 * @property {number=} bus
 * @property {number=} device
 * @property {number=} speedHz
 * @property {number=} gpio
 * @property {number=} threshold
 * @property {number=} captureMs
 * @property {number=} minEdges
 * @property {number=} cooldownMs
 * @property {number=} pretriggerUs
 * @property {number=} silenceGapUs
 * @property {number=} pollMs
 * @property {(message: string) => void=} onMessage
 * @property {(frame: RawFrame, summary: RawFrameSummary | null) => void=} onFrame
 */

class CC1101RawListener {
  /**
   * @param {RawListenerOptions=} options
   */
  constructor(options = {}) {
    this.options = {
      bus: options.bus ?? 0,
      device: options.device ?? 0,
      speedHz: options.speedHz ?? 100000,
      gpio: options.gpio ?? 24,
      threshold: options.threshold ?? 100,
      captureMs: options.captureMs ?? 220,
      minEdges: options.minEdges ?? 20,
      cooldownMs: options.cooldownMs ?? 400,
      pretriggerUs: options.pretriggerUs ?? 10000,
      silenceGapUs: options.silenceGapUs ?? 10000,
      pollMs: options.pollMs ?? 5,
      onMessage: options.onMessage ?? ((message) => console.log(message)),
      onFrame: options.onFrame ?? ((frame, summary) => {
        this.options.onMessage("---- raw trigger ----");
        this.options.onMessage(`ts:          ${frame.ts}`);
        this.options.onMessage(`triggerRSSI: ${frame.triggerRssi}`);
        this.options.onMessage(`edges:       ${frame.edges}`);
        this.options.onMessage(`levels:      ${frame.levels.join(",")}`);
        this.options.onMessage(`durations:   ${frame.durationsUs.join(",")}`);
        for (const line of renderSignalSummary({
          label: "raw",
          units: frame.durationsUs,
          levels: frame.levels,
          durationsUs: frame.durationsUs,
        })) {
          this.options.onMessage(line);
        }
        this.options.onMessage("");

        if (summary) {
          this.options.onMessage("---- analyzed frame ----");
          this.options.onMessage(`ts:          ${summary.ts}`);
          this.options.onMessage(`triggerRSSI: ${summary.triggerRssi}`);
          this.options.onMessage(`edges:       ${summary.edges}`);
          this.options.onMessage(`baseUnit:    ~${summary.baseUnitUs} us`);
          this.options.onMessage(`units:       ${summary.units.join(",")}`);
          for (const line of renderSignalSummary({
            label: "analyzed",
            units: summary.units,
          })) {
            this.options.onMessage(line);
          }

          summary.segments.forEach((segment, index) => {
            this.options.onMessage(`segment ${index + 1} units:   ${segment.units.join(",")}`);
            this.options.onMessage(`segment ${index + 1} symbols: ${segment.symbols}`);
            this.options.onMessage(`segment ${index + 1} compact: ${segment.compact}`);
            this.options.onMessage(`segment ${index + 1} bits?:   ${segment.bits}`);
          });
          this.options.onMessage("");
        }
      }),
    };

    this.radio = null;
    this.input = null;
    this.loopPromise = null;
    this.stopping = false;
    this.capturing = false;
    this.captureUntil = 0;
    this.cooldownUntil = 0;
    this.currentTriggerRssi = null;
    this.lastTick = 0;
    this.preBuffer = [];
    this.frameBuffer = [];
  }

  async getRssiRaw() {
    if (!this.radio) {
      throw new Error("Raw listener radio is not initialized");
    }

    return this.radio.readRegister(STATUS.RSSI);
  }

  resetFrameBuffer() {
    this.frameBuffer = [];
  }

  trimPreBuffer() {
    let total = 0;
    const kept = [];

    for (let i = this.preBuffer.length - 1; i >= 0; i -= 1) {
      const edge = this.preBuffer[i];
      total += edge.dtUs;
      kept.push(edge);
      if (total >= this.options.pretriggerUs) break;
    }

    this.preBuffer = kept.reverse();
  }

  pushPreEdge(edge) {
    this.preBuffer.push(edge);
    this.trimPreBuffer();
  }

  beginCapture(rssi, now) {
    this.capturing = true;
    this.captureUntil = now + this.options.captureMs;
    this.currentTriggerRssi = rssi;
    this.frameBuffer = [...this.preBuffer];
    this.options.onMessage(`trigger rssi=${rssi}`);
  }

  endCapture(reason) {
    this.capturing = false;

    if (this.frameBuffer.length < this.options.minEdges) {
      this.resetFrameBuffer();
      this.currentTriggerRssi = null;
      this.cooldownUntil = Date.now() + 100;
      return;
    }

    /** @type {RawFrame} */
    const frame = {
      ts: new Date().toISOString(),
      reason,
      triggerRssi: this.currentTriggerRssi,
      edges: this.frameBuffer.length,
      durationsUs: this.frameBuffer.map((edge) => edge.dtUs),
      levels: this.frameBuffer.map((edge) => edge.level),
    };

    const summary = summarizeFrame(frame);
    this.options.onFrame(frame, summary);

    this.resetFrameBuffer();
    this.currentTriggerRssi = null;
    this.cooldownUntil = Date.now() + this.options.cooldownMs;
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

    const edge = { level, dtUs };
    this.pushPreEdge(edge);

    if (this.capturing) {
      this.frameBuffer.push(edge);

      if (dtUs >= this.options.silenceGapUs && this.frameBuffer.length >= this.options.minEdges) {
        this.endCapture("silence-gap");
      }
    }
  }

  async start() {
    if (this.loopPromise) return;

    this.stopping = false;
    this.lastTick = 0;
    this.preBuffer = [];
    this.frameBuffer = [];
    this.capturing = false;
    this.captureUntil = 0;
    this.cooldownUntil = 0;
    this.currentTriggerRssi = null;

    this.radio = new CC1101Driver({
      bus: this.options.bus,
      device: this.options.device,
      speedHz: this.options.speedHz,
    });
    this.input = new Gpio(this.options.gpio, {
      mode: Gpio.INPUT,
      alert: true,
    });

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
      `armed on RSSI < ${this.options.threshold}, capture=${this.options.captureMs}ms, minEdges=${this.options.minEdges}, pretrigger=${this.options.pretriggerUs}us, silenceGap=${this.options.silenceGapUs}us`
    );

    this.input.on("alert", (level, tick) => this.handleAlert(level, tick));
    this.loopPromise = this.runLoop().finally(() => {
      this.loopPromise = null;
    });
  }

  async runLoop() {
    while (!this.stopping) {
      const now = Date.now();
      const rssi = await this.getRssiRaw();

      if (!this.capturing && now >= this.cooldownUntil && rssi < this.options.threshold) {
        this.beginCapture(rssi, now);
      }

      if (this.capturing && now >= this.captureUntil) {
        this.endCapture("capture-window");
      }

      await sleep(this.options.pollMs);
    }
  }

  async stop() {
    this.stopping = true;

    if (this.capturing) {
      try {
        this.endCapture("shutdown");
      } catch {}
    }

    if (this.input) {
      try {
        this.input.disableAlert();
      } catch {}
      this.input = null;
    }

    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
    }

    if (this.radio) {
      try {
        await this.radio.idle();
      } catch {}
      await this.radio.close().catch(() => {});
      this.radio = null;
    }
  }
}

module.exports = {
  CC1101RawListener,
};
