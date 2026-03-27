// @ts-check

const { Gpio } = require("pigpio");
const { CC1101Driver } = require("../driver");
const { BAND, MODULATION, RADIO_MODE } = require("../profiles");
const { sleep } = require("../utils");
const { renderRawSignal } = require("./capture-file");

/**
 * @typedef {"silence" | "signal_detected"} RawListenerState
 *
 * @typedef {object} RawFrame
 * @property {string} ts
 * @property {string} reason
 * @property {number} edges
 * @property {number[]} durationsUs
 * @property {number[]} levels
 *
 * @typedef {object} RawListenerOptions
 * @property {number=} bus
 * @property {number=} device
 * @property {number=} speedHz
 * @property {number=} gpio
 * @property {number=} silenceGapUs
 * @property {number=} pollMs
 * @property {(message: string) => void=} onMessage
 * @property {(frame: RawFrame) => void=} onFrame
 * @property {(state: RawListenerState) => void=} onStateChange
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
      silenceGapUs: options.silenceGapUs ?? 10000,
      pollMs: options.pollMs ?? 5,
      onMessage: options.onMessage ?? ((message) => console.log(message)),
      onFrame: options.onFrame ?? ((frame) => {
        this.options.onMessage("---- raw signal ----");
        this.options.onMessage(`ts:          ${frame.ts}`);
        this.options.onMessage(`reason:      ${frame.reason}`);
        const rendered = renderRawSignal(frame);
        if (rendered) {
          this.options.onMessage(rendered);
        } else {
          this.options.onMessage(`edges:       ${frame.edges}`);
          this.options.onMessage(`levels:      ${frame.levels.join(",")}`);
          this.options.onMessage(`durations:   ${frame.durationsUs.join(",")}`);
        }
        this.options.onMessage("");
      }),
      onStateChange: options.onStateChange ?? ((state) => {
        this.options.onMessage(`state=${state}`);
      }),
    };

    this.radio = null;
    this.input = null;
    this.loopPromise = null;
    this.stopping = false;
    this.lastTick = 0;
    this.lastEdgeAtUs = 0;
    /** @type {Array<{ level: number, dtUs: number }>} */
    this.frameBuffer = [];
    /** @type {RawListenerState} */
    this.state = "silence";
  }

  setState(nextState) {
    if (this.state === nextState) return;
    this.state = nextState;
    this.options.onStateChange(nextState);
  }

  resetFrameBuffer() {
    this.frameBuffer = [];
  }

  emitFrame(reason) {
    if (this.frameBuffer.length === 0) {
      this.resetFrameBuffer();
      return;
    }

    /** @type {RawFrame} */
    const frame = {
      ts: new Date().toISOString(),
      reason,
      edges: this.frameBuffer.length,
      durationsUs: this.frameBuffer.map((edge) => edge.dtUs),
      levels: this.frameBuffer.map((edge) => edge.level),
    };

    this.options.onFrame(frame);
    this.resetFrameBuffer();
  }

  handleAlert(level, tick) {
    if (this.stopping) {
      this.lastTick = tick;
      return;
    }

    const nowUs = Date.now() * 1000;

    if (this.lastTick === 0) {
      this.lastTick = tick;
      this.lastEdgeAtUs = nowUs;
      this.setState("signal_detected");
      this.frameBuffer.push({ level, dtUs: 0 });
      return;
    }

    let dtUs = tick - this.lastTick;
    if (dtUs < 0) dtUs += 0x100000000;
    this.lastTick = tick;
    this.lastEdgeAtUs = nowUs;

    if (dtUs >= this.options.silenceGapUs) {
      this.emitFrame("silence-gap");
      this.setState("silence");
      this.setState("signal_detected");
      this.frameBuffer.push({ level, dtUs: 0 });
      return;
    }

    this.frameBuffer.push({ level, dtUs });
  }

  async start() {
    if (this.loopPromise) return;

    this.stopping = false;
    this.lastTick = 0;
    this.lastEdgeAtUs = 0;
    this.frameBuffer = [];
    this.state = "silence";

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
      `raw edge listen gpio=${this.options.gpio} silenceGapUs=${this.options.silenceGapUs}`
    );
    this.options.onStateChange(this.state);

    this.input.on("alert", (level, tick) => this.handleAlert(level, tick));
    this.loopPromise = this.runLoop().finally(() => {
      this.loopPromise = null;
    });
  }

  async runLoop() {
    while (!this.stopping) {
      const nowUs = Date.now() * 1000;

      if (
        this.state === "signal_detected" &&
        this.lastEdgeAtUs > 0 &&
        nowUs - this.lastEdgeAtUs >= this.options.silenceGapUs
      ) {
        this.emitFrame("silence-timeout");
        this.setState("silence");
      }

      await sleep(this.options.pollMs);
    }
  }

  async stop() {
    this.stopping = true;

    if (this.state === "signal_detected") {
      try {
        this.emitFrame("shutdown");
      } catch {}
      this.setState("silence");
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
