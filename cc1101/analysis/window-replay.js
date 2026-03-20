// @ts-check

const { Gpio } = require("pigpio");
const { CC1101Driver } = require("../driver");
const { sleep } = require("../utils");
const { renderBars } = require("./raw-analysis");
const { loadCaptureFile } = require("./capture-file");

/**
 * @typedef {"raw" | "normalized"} ReplayMode
 *
 * @typedef {object} ReplayWindow
 * @property {ReplayMode} mode
 * @property {number} baseUs
 * @property {number} start
 * @property {number} end
 * @property {number[]} levels
 * @property {number[]} durationsUs
 * @property {number[]} units
 *
 * @typedef {object} WindowReplayOptions
 * @property {number=} bus
 * @property {number=} device
 * @property {number=} speedHz
 * @property {number=} txDataGpio
 * @property {number=} gpio
 * @property {number=} repeats
 * @property {number=} repeatGapUs
 * @property {number=} preDelayMs
 * @property {(message: string) => void=} onMessage
 */

function sleepUs(us) {
  const start = process.hrtime.bigint();
  const target = BigInt(us);
  while ((process.hrtime.bigint() - start) / 1000n < target) {
    // busy wait
  }
}

/**
 * @param {any} capture
 * @param {{
 *   mode?: ReplayMode,
 *   baseUs?: number,
 *   sliceStart?: number,
 *   sliceEnd?: number
 * }=} options
 * @returns {ReplayWindow}
 */
function buildReplayFromCapture(capture, options = {}) {
  const mode = options.mode ?? "normalized";
  const baseUs = Number(options.baseUs ?? capture.baseUs ?? 400);
  const total = capture.edges?.length ?? capture.levels?.length ?? 0;
  const sliceStart = options.sliceStart ?? 0;
  const sliceEnd = options.sliceEnd ?? (total - 1);
  const start = Math.max(0, sliceStart);
  const end = Math.min(total - 1, sliceEnd);

  if (total === 0 || start > end) {
    throw new Error("Invalid or empty capture/slice");
  }

  const levels = [];
  const durationsUs = [];
  const units = [];

  if (capture.edges && Array.isArray(capture.edges)) {
    for (let i = start; i <= end; i += 1) {
      const edge = capture.edges[i];
      levels.push(edge.level);
      units.push(edge.units);
      durationsUs.push(mode === "raw" ? edge.dtUs : (edge.units || 1) * baseUs);
    }
  } else if (
    Array.isArray(capture.levels) &&
    Array.isArray(capture.durationsUs) &&
    Array.isArray(capture.units)
  ) {
    for (let i = start; i <= end; i += 1) {
      levels.push(capture.levels[i]);
      units.push(capture.units[i]);
      durationsUs.push(mode === "raw" ? capture.durationsUs[i] : (capture.units[i] || 1) * baseUs);
    }
  } else {
    throw new Error("Unsupported capture file format");
  }

  return {
    mode,
    baseUs,
    start,
    end,
    levels,
    durationsUs,
    units,
  };
}

class CC1101WindowReplayer {
  /**
   * @param {WindowReplayOptions=} options
   */
  constructor(options = {}) {
    this.options = {
      bus: options.bus ?? 0,
      device: options.device ?? 0,
      speedHz: options.speedHz ?? 100000,
      txDataGpio: options.txDataGpio ?? options.gpio ?? 24,
      repeats: options.repeats ?? 10,
      repeatGapUs: options.repeatGapUs ?? 10000,
      preDelayMs: options.preDelayMs ?? 1000,
      onMessage: options.onMessage ?? ((message) => console.log(message)),
    };
  }

  /**
   * @param {ReplayWindow} replay
   * @returns {Promise<void>}
   */
  async replay(replay) {
    const radio = new CC1101Driver({
      bus: this.options.bus,
      device: this.options.device,
      speedHz: this.options.speedHz,
    });
    const txDataPin = new Gpio(this.options.txDataGpio, { mode: Gpio.OUTPUT, alert: false });

    try {
      await radio.open();
      await radio.reset();
      await radio.verifyChip();
      await radio.startDirectAsyncTx();

      this.options.onMessage(`txDataGpio:    ${this.options.txDataGpio}`);
      this.options.onMessage(`mode:          ${replay.mode}`);
      this.options.onMessage(`baseUs:        ${replay.baseUs}`);
      this.options.onMessage(`slice:         ${replay.start}..${replay.end}`);
      this.options.onMessage(`steps:         ${replay.durationsUs.length}`);
      this.options.onMessage(`repeats:       ${this.options.repeats}`);
      this.options.onMessage(`repeatGapUs:   ${this.options.repeatGapUs}`);
      this.options.onMessage(`bars:          ${renderBars(replay.units, 160)}`);
      this.options.onMessage("");

      if (this.options.preDelayMs > 0) {
        this.options.onMessage(`waiting ${this.options.preDelayMs} ms before TX...`);
        await sleep(this.options.preDelayMs);
      }

      for (let repeat = 0; repeat < this.options.repeats; repeat += 1) {
        for (let i = 0; i < replay.durationsUs.length; i += 1) {
          txDataPin.digitalWrite(replay.levels[i] ? 1 : 0);
          sleepUs(replay.durationsUs[i]);
        }

        txDataPin.digitalWrite(0);
        sleepUs(this.options.repeatGapUs);
      }

      this.options.onMessage("TX done");
    } finally {
      try {
        txDataPin.digitalWrite(0);
      } catch {}
      try {
        await radio.idle();
      } catch {}
      await radio.close().catch(() => {});
    }
  }
}

module.exports = {
  buildReplayFromCapture,
  CC1101WindowReplayer,
  loadCaptureFile,
};
