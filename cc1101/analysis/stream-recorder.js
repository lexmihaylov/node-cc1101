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
 * @property {number=} previewIntervalMs
 * @property {number=} previewEdgeWindow
 * @property {number=} previewWindowMs
 * @property {number=} previewSampleMs
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
      rxDataGpio: options.rxDataGpio ?? 25,
      previewIntervalMs: options.previewIntervalMs ?? 120,
      previewEdgeWindow: options.previewEdgeWindow ?? 16,
      previewWindowMs: options.previewWindowMs ?? 2400,
      previewSampleMs: options.previewSampleMs ?? 25,
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
    /** @type {RecordedStreamEdge[]} */
    this.edges = [];
  }

  /**
   * @param {RecordedStreamEdge[]} recent
   * @param {number} now
   * @returns {string}
   */
  renderSampledRaster(recent, now) {
    const bucketCount = Math.max(8, Math.floor(this.options.previewWindowMs / this.options.previewSampleMs));
    const samples = new Array(bucketCount).fill(null).map(() => ({
      hits: 0,
      level: null,
      maxDtUs: 0,
    }));
    const startMs = now - this.options.previewWindowMs;

    for (const edge of recent) {
      const offsetMs = edge.wallclockMs - startMs;
      const index = Math.floor(offsetMs / this.options.previewSampleMs);
      if (index < 0 || index >= bucketCount) continue;

      const bucket = samples[index];
      bucket.hits += 1;
      bucket.level = edge.level;
      bucket.maxDtUs = Math.max(bucket.maxDtUs, edge.dtUs);
    }

    const activity = samples.map((bucket) => {
      if (bucket.hits === 0) return " ";
      if (bucket.hits === 1) return ".";
      if (bucket.hits <= 3) return ":";
      if (bucket.hits <= 6) return "*";
      return "#";
    }).join("");

    const level = samples.map((bucket) => {
      if (bucket.hits === 0 || bucket.level === null) return " ";
      return bucket.level ? "▀" : "▄";
    }).join("");

    const span = samples.map((bucket) => {
      if (bucket.hits === 0) return " ";
      if (bucket.maxDtUs < 250) return ".";
      if (bucket.maxDtUs < 750) return ":";
      if (bucket.maxDtUs < 2000) return "*";
      return "#";
    }).join("");

    return [
      `time:   ${activity}`,
      `level:  ${level}`,
      `dt:     ${span}`,
      `legend: activity[ . : * # ]  dt[ . <250us | : <750us | * <2000us | # >=2000us ]  sample=${this.options.previewSampleMs}ms  span=${this.options.previewWindowMs}ms`,
    ].join("\n");
  }

  emitPreview() {
    const now = Date.now();
    const recent = this.edges.filter((edge) => edge.wallclockMs >= now - this.options.previewWindowMs);
    const recentTail = recent.slice(-this.options.previewEdgeWindow);
    const lines = [
      `preview totalEdges=${this.edges.length} recentEdges=${recent.length} recentTail=${recentTail.length}`,
      this.renderSampledRaster(recent, now),
    ];

    if (recentTail.length === 0) {
      lines.push("edges:  ");
      lines.push("note:   no edges in preview window");
      this.options.onPreview(lines.join("\n"));
      return;
    }

    lines.push(`edges:  ${recentTail.map((edge) => `${edge.level}@${edge.dtUs}`).join("  ")}`);

    this.options.onPreview(lines.join("\n"));
  }

  handleAlert(level, tick) {
    if (this.stopping) {
      this.lastTick = tick;
      return;
    }

    if (this.lastTick === 0) {
      this.lastTick = tick;
      this.edges.push({
        idx: this.edges.length,
        level,
        dtUs: 0,
        wallclockMs: Date.now(),
      });
      return;
    }

    let dtUs = tick - this.lastTick;
    if (dtUs < 0) dtUs += 0x100000000;
    this.lastTick = tick;

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
        gdo0: VALUE.IOCFG.HIGH_IMPEDANCE,
        gdo2: VALUE.IOCFG.ASYNC_SERIAL_DATA,
      },
      packet: {
        appendStatus: false,
      },
    });

    this.rxDataPin.on("alert", (level, tick) => this.handleAlert(level, tick));
    this.previewTimer = setInterval(() => this.emitPreview(), this.options.previewIntervalMs);
    this.options.onMessage(
      `recording stream rxDataGpio=${this.options.rxDataGpio} file=${this.options.filepath}`
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
