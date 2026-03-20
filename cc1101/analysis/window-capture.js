// @ts-check

const fs = require("fs");
const { Gpio } = require("pigpio");
const { CC1101Driver } = require("../driver");
const { STATUS, VALUE } = require("../constants");
const { BAND, MODULATION, RADIO_MODE } = require("../profiles");
const { sleep } = require("../utils");
const { renderBars } = require("./raw-analysis");
const { buildCaptureFilepath, saveCaptureFile } = require("./capture-file");

/**
 * @typedef {object} QuantizedCaptureEdge
 * @property {number} idx
 * @property {number} level
 * @property {number} dtUs
 * @property {number} snappedUs
 * @property {number} units
 * @property {number} wallclockMs
 *
 * @typedef {object} WindowCaptureRecord
 * @property {number} id
 * @property {string} ts
 * @property {number} triggerRssi
 * @property {number} threshold
 * @property {number} baseUs
 * @property {number} beforeMs
 * @property {number} afterMs
 * @property {number} minDtUs
 * @property {number} edgeCount
 * @property {QuantizedCaptureEdge[]} edges
 * @property {number[]} levels
 * @property {number[]} durationsUs
 * @property {number[]} snappedUs
 * @property {number[]} units
 *
 * @typedef {object} WindowCaptureOptions
 * @property {number=} bus
 * @property {number=} device
 * @property {number=} speedHz
 * @property {number=} rxDataGpio
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
 * @property {string=} outDir
 * @property {string=} prefix
 * @property {(message: string) => void=} onMessage
 * @property {(capture: WindowCaptureRecord, filepath: string) => void=} onCapture
 */

function trimHistory(edges, historyMs) {
  const cutoff = Date.now() - historyMs;
  while (edges.length && edges[0].wallclockMs < cutoff) {
    edges.shift();
  }
}

function roundToNiceTiming(us) {
  const nice = [
    100, 125, 150, 175, 200, 225, 250, 275, 300, 325, 350, 375, 400, 450,
    500, 550, 600, 650, 700, 750, 800, 850, 900, 1000, 1100, 1200, 1250,
    1500, 1750, 2000, 2250, 2500, 3000, 3500, 4000, 4500, 5000, 6000,
  ];

  let best = nice[0];
  let bestDiff = Math.abs(us - best);

  for (const n of nice) {
    const diff = Math.abs(us - n);
    if (diff < bestDiff) {
      best = n;
      bestDiff = diff;
    }
  }

  return best;
}

/**
 * @param {{ level: number, dtUs: number, wallclockMs: number }[]} edges
 * @param {number} baseUs
 * @param {boolean=} niceSnap
 * @returns {QuantizedCaptureEdge[]}
 */
function quantizeEdges(edges, baseUs, niceSnap = true) {
  return edges.map((edge, idx) => {
    const snappedUs = niceSnap ? roundToNiceTiming(edge.dtUs) : edge.dtUs;
    return {
      idx,
      level: edge.level,
      dtUs: edge.dtUs,
      snappedUs,
      units: Math.max(1, Math.round(snappedUs / baseUs)),
      wallclockMs: edge.wallclockMs,
    };
  });
}

class CC1101WindowCapture {
  /**
   * @param {WindowCaptureOptions=} options
   */
  constructor(options = {}) {
    this.options = {
      bus: options.bus ?? 0,
      device: options.device ?? 0,
      speedHz: options.speedHz ?? 100000,
      rxDataGpio: options.rxDataGpio ?? options.gdo0 ?? 24,
      threshold: options.threshold ?? 100,
      baseUs: options.baseUs ?? 400,
      beforeMs: options.beforeMs ?? 1000,
      afterMs: options.afterMs ?? 1000,
      historyMs: options.historyMs ?? Math.max(4000, (options.beforeMs ?? 1000) + (options.afterMs ?? 1000) + 1000),
      cooldownMs: options.cooldownMs ?? 1000,
      pollMs: options.pollMs ?? 5,
      minDtUs: options.minDtUs ?? 80,
      niceSnap: options.niceSnap ?? true,
      outDir: options.outDir ?? "/tmp/rf-captures",
      prefix: options.prefix ?? "capture",
      onMessage: options.onMessage ?? ((message) => console.log(message)),
      onCapture: options.onCapture ?? ((capture, filepath) => {
        this.options.onMessage("============================================================");
        this.options.onMessage(`PRESS ${capture.id}   ts=${capture.ts}   triggerRSSI=${capture.triggerRssi}`);
        this.options.onMessage(`saved:        ${filepath}`);
        this.options.onMessage(`edges:        ${capture.edgeCount}`);
        this.options.onMessage(`bars:         ${renderBars(capture.units, 160)}`);
        this.options.onMessage("");
      }),
    };

    this.radio = null;
    this.rxDataPin = null;
    this.loopPromise = null;
    this.stopping = false;
    this.lastTick = 0;
    this.pressId = 0;
    this.cooldownUntil = 0;
    this.pendingTrigger = null;
    this.edges = [];
  }

  async getRssiRaw() {
    if (!this.radio) {
      throw new Error("Window capture radio is not initialized");
    }

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

    fs.mkdirSync(this.options.outDir, { recursive: true });

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
    await sleep(100);

    this.options.onMessage(
      `window capture started rxDataGpio=${this.options.rxDataGpio} cc1101DataGdo=gdo2 threshold=${this.options.threshold} baseUs=${this.options.baseUs} beforeMs=${this.options.beforeMs} afterMs=${this.options.afterMs} outDir=${this.options.outDir}`
    );

    this.rxDataPin.on("alert", (level, tick) => this.handleAlert(level, tick));
    this.loopPromise = this.runLoop().finally(() => {
      this.loopPromise = null;
    });
  }

  async runLoop() {
    while (!this.stopping) {
      const now = Date.now();
      const rssi = await this.getRssiRaw().catch(() => null);

      if (
        !this.pendingTrigger &&
        now >= this.cooldownUntil &&
        rssi !== null &&
        rssi < this.options.threshold
      ) {
        this.pendingTrigger = {
          triggerTimeMs: now,
          triggerRssi: rssi,
        };
        this.options.onMessage(`trigger rssi=${rssi}`);
      }

      if (this.pendingTrigger && now >= this.pendingTrigger.triggerTimeMs + this.options.afterMs) {
        const startMs = this.pendingTrigger.triggerTimeMs - this.options.beforeMs;
        const endMs = this.pendingTrigger.triggerTimeMs + this.options.afterMs;
        const windowEdges = this.edges.filter(
          (edge) => edge.wallclockMs >= startMs && edge.wallclockMs <= endMs
        );
        const quantized = quantizeEdges(windowEdges, this.options.baseUs, this.options.niceSnap);

        /** @type {WindowCaptureRecord} */
        const capture = {
          id: ++this.pressId,
          ts: new Date().toISOString(),
          triggerRssi: this.pendingTrigger.triggerRssi,
          threshold: this.options.threshold,
          baseUs: this.options.baseUs,
          beforeMs: this.options.beforeMs,
          afterMs: this.options.afterMs,
          minDtUs: this.options.minDtUs,
          edgeCount: quantized.length,
          edges: quantized,
          levels: quantized.map((edge) => edge.level),
          durationsUs: quantized.map((edge) => edge.dtUs),
          snappedUs: quantized.map((edge) => edge.snappedUs),
          units: quantized.map((edge) => edge.units),
        };

        const filepath = buildCaptureFilepath(
          this.options.outDir,
          this.options.prefix,
          capture.id,
          capture.ts
        );

        saveCaptureFile(filepath, capture);
        this.options.onCapture(capture, filepath);

        this.pendingTrigger = null;
        this.cooldownUntil = now + this.options.cooldownMs;
      }

      await sleep(this.options.pollMs);
    }
  }

  async stop() {
    this.stopping = true;

    if (this.rxDataPin) {
      try {
        this.rxDataPin.disableAlert();
      } catch {}
      this.rxDataPin = null;
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
  CC1101WindowCapture,
  quantizeEdges,
};
