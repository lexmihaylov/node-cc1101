// @ts-check

const fs = require("fs");
const path = require("path");
const { Gpio } = require("pigpio");
const { CC1101Driver } = require("../driver");
const { BAND, MODULATION, RADIO_MODE } = require("../profiles");
const { VALUE } = require("../constants");
const { saveCaptureFile } = require("./capture-file");
const { summarizeFrame, renderBars } = require("./raw-analysis");
const { renderSignalSummary } = require("./signal-renderer");

/**
 * @typedef {object} StreamRecorderOptions
 * @property {number=} bus
 * @property {number=} device
 * @property {number=} speedHz
 * @property {number=} rxDataGpio
 * @property {number=} minDtUs
 * @property {number=} baseUs
 * @property {number=} previewIntervalMs
 * @property {number=} previewEdgeWindow
 * @property {string=} filepath
 * @property {(message: string) => void=} onMessage
 * @property {(frame: string) => void=} onPreview
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
      previewIntervalMs: options.previewIntervalMs ?? 500,
      previewEdgeWindow: options.previewEdgeWindow ?? 48,
      filepath: options.filepath ?? "/tmp/rf-stream.json",
      onMessage: options.onMessage ?? ((message) => console.log(message)),
      onPreview: options.onPreview ?? ((frame) => console.log(frame)),
    };

    this.radio = null;
    this.rxDataPin = null;
    this.stopping = false;
    this.lastTick = 0;
    this.startedAtMs = 0;
    this.previewTimer = null;
    this.lastPreviewCount = 0;
    /** @type {RecordedStreamEdge[]} */
    this.edges = [];
  }

  emitPreview() {
    if (this.edges.length === 0 || this.edges.length === this.lastPreviewCount) return;

    this.lastPreviewCount = this.edges.length;
    const recent = this.edges.slice(-this.options.previewEdgeWindow);
    const levels = recent.map((edge) => edge.level);
    const durationsUs = recent.map((edge) => edge.dtUs);
    const units = durationsUs.map((duration) => Math.max(1, Math.round(duration / this.options.baseUs)));
    const frame = {
      ts: new Date().toISOString(),
      reason: "preview",
      triggerRssi: null,
      edges: recent.length,
      durationsUs,
      levels,
    };
    const summary = summarizeFrame(frame);
    const lines = [
      `preview totalEdges=${this.edges.length} recentEdges=${recent.length}`,
      ...renderSignalSummary({
        label: "preview",
        units,
        levels,
        durationsUs,
        maxSteps: 24,
      }),
    ];

    if (summary) {
      lines.push(`raster: ${renderBars(summary.units, 48)}`);
      for (const [index, segment] of summary.segments.slice(0, 2).entries()) {
        lines.push(`seg${index + 1}: units=${segment.units.join(",")} bits=${segment.bits} compact=${segment.compact}`);
      }
    }

    this.options.onPreview(lines.join("\n"));
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
    this.lastPreviewCount = 0;
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
    this.previewTimer = setInterval(() => this.emitPreview(), this.options.previewIntervalMs);
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

    if (this.previewTimer) {
      clearInterval(this.previewTimer);
      this.previewTimer = null;
    }

    this.emitPreview();

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
