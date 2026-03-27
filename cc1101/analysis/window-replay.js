// @ts-check

const { Gpio } = require("pigpio");
const { CC1101Driver } = require("../driver");
const { sleep } = require("../utils");
const { loadCaptureFile, segmentRawFrames } = require("./capture-file");

/**
 * @typedef {object} ReplayWindow
 * @property {number} frameIndex
 * @property {number} start
 * @property {number} end
 * @property {number[]} levels
 * @property {number[]} durationsUs
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
 * @property {boolean=} invert
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
 * @param {{ silenceGapUs?: number, frameIndex?: number, minimumPulseWidthUs?: number }=} options
 * @returns {ReplayWindow}
 */
function buildReplayFromCapture(capture, options = {}) {
  let frameIndex = options.frameIndex ?? 0;
  let start = 0;
  let end = 0;
  let levels = [];
  let durationsUs = [];

  if (capture.edges && Array.isArray(capture.edges)) {
    const silenceGapUs = Number(options.silenceGapUs ?? 10000);
    const minimumPulseWidthUs = Number(options.minimumPulseWidthUs ?? 150);
    const frames = segmentRawFrames(capture, silenceGapUs, 1, minimumPulseWidthUs);
    const frame = frames[frameIndex];
    if (!frame) {
      throw new Error(`No frame ${frameIndex} found with silenceGapUs=${silenceGapUs}`);
    }

    start = frame.startEdgeIndex;
    end = frame.endEdgeIndex;
    levels = frame.levels.slice();
    durationsUs = frame.durationsUs.slice();
  } else if (
    Array.isArray(capture.levels) &&
    Array.isArray(capture.durationsUs)
  ) {
    frameIndex = 0;
    start = 0;
    end = capture.levels.length - 1;
    levels = capture.levels.map((value) => Number(value));
    durationsUs = capture.durationsUs.map((value) => Number(value));
  } else {
    throw new Error("Unsupported capture file format");
  }

  if (!levels.length || levels.length !== durationsUs.length) {
    throw new Error("Invalid or empty replay frame");
  }

  return {
    frameIndex,
    start,
    end,
    levels,
    durationsUs,
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
      invert: options.invert ?? false,
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
      this.options.onMessage(`frame:         ${replay.frameIndex}`);
      this.options.onMessage(`slice:         ${replay.start}..${replay.end}`);
      this.options.onMessage(`steps:         ${replay.durationsUs.length}`);
      this.options.onMessage(`repeats:       ${this.options.repeats}`);
      this.options.onMessage(`repeatGapUs:   ${this.options.repeatGapUs}`);
      this.options.onMessage(`invert:        ${this.options.invert ? "yes" : "no"}`);
      this.options.onMessage(`levels:        ${replay.levels.map((level) => this.options.invert ? (level ? 0 : 1) : level).join(",")}`);
      this.options.onMessage(`durationsUs:   ${replay.durationsUs.join(",")}`);
      this.options.onMessage("");

      if (this.options.preDelayMs > 0) {
        this.options.onMessage(`waiting ${this.options.preDelayMs} ms before TX...`);
        await sleep(this.options.preDelayMs);
      }

      for (let repeat = 0; repeat < this.options.repeats; repeat += 1) {
        const firstLevel = this.options.invert ? (replay.levels[0] ? 0 : 1) : replay.levels[0];
        txDataPin.digitalWrite(firstLevel ? 0 : 1);
        for (let i = 0; i < replay.durationsUs.length; i += 1) {
          sleepUs(replay.durationsUs[i]);
          const level = this.options.invert ? (replay.levels[i] ? 0 : 1) : replay.levels[i];
          txDataPin.digitalWrite(level ? 1 : 0);
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
