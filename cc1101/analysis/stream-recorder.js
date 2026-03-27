// @ts-check

const fs = require("fs");
const path = require("path");
const { Gpio } = require("pigpio");
const { CC1101Driver } = require("../driver");
const { BAND, MODULATION, RADIO_MODE } = require("../profiles");
const { VALUE } = require("../constants");
const { saveCaptureFile } = require("./capture-file");

/**
 * @typedef {object} StreamRecorderOptions
 * @property {number=} bus
 * @property {number=} device
 * @property {number=} speedHz
 * @property {number=} rxDataGpio
 * @property {number=} minDtUs
 * @property {number=} baseUs
 * @property {string=} filepath
 * @property {(message: string) => void=} onMessage
 *
 * @typedef {object} RecordedStreamEdge
 * @property {number} idx
 * @property {number} level
 * @property {number} dtUs
 * @property {number} wallclockMs
 *
 * @typedef {object} RecordedStreamFile
 * @property {"edge_stream"} type
 * @property {string} ts
 * @property {number} startedAtMs
 * @property {number} stoppedAtMs
 * @property {number} durationMs
 * @property {number} edgeCount
 * @property {number} rxDataGpio
 * @property {number} minDtUs
 * @property {number} baseUs
 * @property {string} band
 * @property {string} modulation
 * @property {string} mode
 * @property {RecordedStreamEdge[]} edges
 */

class CC1101StreamRecorder {
  /**
   * @param {StreamRecorderOptions=} options
   */
  constructor(options = {}) {
    this.options = {
      bus: options.bus ?? 0,
      device: options.device ?? 0,
      speedHz: options.speedHz ?? 100000,
      rxDataGpio: options.rxDataGpio ?? 24,
      minDtUs: options.minDtUs ?? 80,
      baseUs: options.baseUs ?? 400,
      filepath: options.filepath ?? "/tmp/rf-stream.json",
      onMessage: options.onMessage ?? ((message) => console.log(message)),
    };

    this.radio = null;
    this.rxDataPin = null;
    this.stopping = false;
    this.lastTick = 0;
    this.startedAtMs = 0;
    /** @type {RecordedStreamEdge[]} */
    this.edges = [];
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
      idx: this.edges.length,
      level,
      dtUs,
      wallclockMs: Date.now(),
    });
  }

  async start() {
    if (this.radio) return;

    fs.mkdirSync(path.dirname(this.options.filepath), { recursive: true });

    this.stopping = false;
    this.lastTick = 0;
    this.startedAtMs = Date.now();
    this.edges = [];

    this.radio = new CC1101Driver({
      bus: this.options.bus,
      device: this.options.device,
      speedHz: this.options.speedHz,
    });
    this.rxDataPin = new Gpio(this.options.rxDataGpio, {
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
      gpio: {
        gdo0: VALUE.IOCFG.ASYNC_SERIAL_DATA,
        gdo2: VALUE.IOCFG.PQI,
      },
      packet: {
        appendStatus: false,
      },
    });

    this.rxDataPin.on("alert", (level, tick) => this.handleAlert(level, tick));
    this.options.onMessage(
      `recording stream rxDataGpio=${this.options.rxDataGpio} minDtUs=${this.options.minDtUs} baseUs=${this.options.baseUs} file=${this.options.filepath}`
    );
    this.options.onMessage("use `stop` to finish and save the stream");
  }

  /**
   * @returns {Promise<RecordedStreamFile>}
   */
  async stop() {
    this.stopping = true;

    if (this.rxDataPin) {
      try {
        this.rxDataPin.disableAlert();
      } catch {}
      this.rxDataPin = null;
    }

    if (this.radio) {
      try {
        await this.radio.idle();
      } catch {}
      await this.radio.close().catch(() => {});
      this.radio = null;
    }

    const stoppedAtMs = Date.now();
    /** @type {RecordedStreamFile} */
    const stream = {
      type: "edge_stream",
      ts: new Date(this.startedAtMs).toISOString(),
      startedAtMs: this.startedAtMs,
      stoppedAtMs,
      durationMs: Math.max(0, stoppedAtMs - this.startedAtMs),
      edgeCount: this.edges.length,
      rxDataGpio: this.options.rxDataGpio,
      minDtUs: this.options.minDtUs,
      baseUs: this.options.baseUs,
      band: BAND.MHZ_433,
      modulation: MODULATION.OOK,
      mode: RADIO_MODE.DIRECT_ASYNC,
      edges: this.edges,
    };

    saveCaptureFile(this.options.filepath, stream);
    this.options.onMessage(
      `saved stream file=${this.options.filepath} durationMs=${stream.durationMs} edgeCount=${stream.edgeCount}`
    );

    return stream;
  }
}

module.exports = {
  CC1101StreamRecorder,
};
