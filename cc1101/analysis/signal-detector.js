// @ts-check

const { Gpio } = require("pigpio");
const { CC1101Driver } = require("../driver");
const { STATUS } = require("../constants");
const { BAND, MODULATION, RADIO_MODE } = require("../profiles");
const { sleep } = require("../utils");
const { shouldAcceptTriggerRssi } = require("./rssi-filter");
const { renderSignalSummary } = require("./signal-renderer");
const {
  compactFrame,
  estimateTimingGrid,
  quantizeEdges,
  scoreFrame,
  splitBySilence,
  trimHistory,
} = require("./signal-analysis");

/**
 * @typedef {import("./signal-analysis").QuantizedSignalEdge} QuantizedSignalEdge
 * @typedef {import("./signal-analysis").SignalTimingGrid} SignalTimingGrid
 *
 * @typedef {object} SignalDetectionResult
 * @property {number} id
 * @property {string} ts
 * @property {number} triggerRssi
 * @property {number} baseUsRaw
 * @property {number} baseUs
 * @property {number[]} clustersUs
 * @property {QuantizedSignalEdge[]} quantizedEdges
 * @property {QuantizedSignalEdge[][]} frames
 *
 * @typedef {object} SignalDetectorOptions
 * @property {number=} bus
 * @property {number=} device
 * @property {number=} speedHz
 * @property {number=} gdo0
 * @property {number=} threshold
 * @property {number=} historyMs
 * @property {number=} lookbackMs
 * @property {number=} settleMs
 * @property {number=} cooldownMs
 * @property {number=} pollMs
 * @property {number=} minDtUs
 * @property {number=} minFrameEdges
 * @property {number=} silenceUnits
 * @property {"ook" | "fsk"=} modulation
 * @property {number | null=} rssiTolerance
 * @property {(message: string) => void=} onMessage
 * @property {(result: SignalDetectionResult) => void=} onDetection
 */

class CC1101SignalDetector {
  /**
   * @param {SignalDetectorOptions=} options
   */
  constructor(options = {}) {
    this.options = {
      bus: options.bus ?? 0,
      device: options.device ?? 0,
      speedHz: options.speedHz ?? 100000,
      gdo0: options.gdo0 ?? 24,
      threshold: options.threshold ?? 100,
      historyMs: options.historyMs ?? 2500,
      lookbackMs: options.lookbackMs ?? 1000,
      settleMs: options.settleMs ?? 220,
      cooldownMs: options.cooldownMs ?? 400,
      pollMs: options.pollMs ?? 5,
      minDtUs: options.minDtUs ?? 20,
      minFrameEdges: options.minFrameEdges ?? 8,
      silenceUnits: options.silenceUnits ?? 12,
      modulation: options.modulation ?? MODULATION.OOK,
      rssiTolerance: options.rssiTolerance ?? null,
      onMessage: options.onMessage ?? ((message) => console.log(message)),
      onDetection: options.onDetection ?? ((result) => {
        this.options.onMessage("---- signal detection ----");
        this.options.onMessage(`id:              ${result.id}`);
        this.options.onMessage(`ts:              ${result.ts}`);
        this.options.onMessage(`triggerRSSI:     ${result.triggerRssi}`);
        this.options.onMessage(`timing raw:      ~${result.baseUsRaw} us`);
        this.options.onMessage(`timing snapped:  ${result.baseUs} us`);
        this.options.onMessage(`clusters:        ${result.clustersUs.join(", ")}`);
        this.options.onMessage(`buffer edges:    ${result.quantizedEdges.length}`);
        this.options.onMessage(`candidateFrames: ${result.frames.length}`);
        this.options.onMessage("");

        result.frames.forEach((frame, index) => {
          const units = frame.map((edge) => edge.units);
          const durations = frame.map((edge) => edge.dtUs);
          const levels = frame.map((edge) => edge.level);
          this.options.onMessage(`  frame ${index + 1}  score=${scoreFrame(frame, this.options.minFrameEdges)}  edges=${frame.length}`);
          this.options.onMessage(`    levels:    ${levels.join(",")}`);
          this.options.onMessage(`    durations: ${durations.join(",")}`);
          this.options.onMessage(`    units:     ${units.join(",")}`);
          this.options.onMessage(`    compact:   ${compactFrame(frame)}`);
          for (const line of renderSignalSummary({
            label: `frame ${index + 1}`,
            units,
            levels,
            durationsUs: durations,
            snappedUs: frame.map((edge) => edge.snappedUs),
          })) {
            this.options.onMessage(`    ${line}`);
          }
        });

        this.options.onMessage("");
      }),
    };

    this.radio = null;
    this.gdo0Pin = null;
    this.loopPromise = null;
    this.stopping = false;
    this.lastTick = 0;
    this.detectionId = 0;
    this.cooldownUntil = 0;
    this.pendingTrigger = null;
    this.edges = [];
    this.lastAcceptedTriggerRssi = null;
  }

  async getRssiRaw() {
    if (!this.radio) throw new Error("Signal detector radio is not initialized");
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
    this.detectionId = 0;
    this.cooldownUntil = 0;
    this.pendingTrigger = null;
    this.edges = [];
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
      modulation: this.options.modulation,
      mode: RADIO_MODE.DIRECT_ASYNC,
    });
    await sleep(100);

    this.options.onMessage(
      `signal detector started gdo0=${this.options.gdo0} modulation=${this.options.modulation} threshold=${this.options.threshold} lookbackMs=${this.options.lookbackMs} settleMs=${this.options.settleMs} rssiTolerance=${this.options.rssiTolerance ?? "off"}`
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

      if (this.pendingTrigger && now - this.pendingTrigger.triggerTimeMs >= this.options.settleMs) {
        const relevant = this.edges.filter((edge) => edge.wallclockMs >= this.pendingTrigger.triggerTimeMs - this.options.lookbackMs);

        if (relevant.length >= this.options.minFrameEdges) {
          const timing = estimateTimingGrid(relevant.map((edge) => edge.dtUs));
          const quantized = quantizeEdges(relevant, timing.baseUs);
          const frames = splitBySilence(quantized, this.options.silenceUnits)
            .filter((frame) => frame.length >= this.options.minFrameEdges)
            .sort((a, b) => scoreFrame(b, this.options.minFrameEdges) - scoreFrame(a, this.options.minFrameEdges))
            .slice(0, 6);

          this.options.onDetection({
            id: ++this.detectionId,
            ts: new Date().toISOString(),
            triggerRssi: this.pendingTrigger.triggerRssi,
            baseUsRaw: timing.baseUsRaw,
            baseUs: timing.baseUs,
            clustersUs: timing.clustersUs,
            quantizedEdges: quantized,
            frames,
          });
          this.lastAcceptedTriggerRssi = this.pendingTrigger.triggerRssi;
        }

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
  CC1101SignalDetector,
};
