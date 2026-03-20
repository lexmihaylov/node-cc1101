// @ts-check

const { Gpio } = require("pigpio");
const { CC1101Driver } = require("../driver");
const { STATUS } = require("../constants");
const { BAND, MODULATION, RADIO_MODE } = require("../profiles");
const { sleep } = require("../utils");
const {
  compactFrame,
  quantizeEdges,
  renderBars,
  scoreSegment,
  splitBySilence,
  trimHistory,
} = require("./signal-analysis");

/**
 * @typedef {import("./signal-analysis").QuantizedSignalEdge} QuantizedSignalEdge
 *
 * @typedef {object} CollectedPress
 * @property {number} id
 * @property {string} ts
 * @property {number} triggerRssi
 * @property {number} baseUs
 * @property {QuantizedSignalEdge[][]} segments
 *
 * @typedef {object} SegmentCollectorOptions
 * @property {number=} bus
 * @property {number=} device
 * @property {number=} speedHz
 * @property {number=} gdo0
 * @property {number=} threshold
 * @property {number=} baseUs
 * @property {number=} historyMs
 * @property {number=} lookbackMs
 * @property {number=} settleMs
 * @property {number=} cooldownMs
 * @property {number=} pollMs
 * @property {number=} minDtUs
 * @property {number=} silenceUnits
 * @property {number=} minSegmentEdges
 * @property {boolean=} niceSnap
 * @property {number=} keepPresses
 * @property {(message: string) => void=} onMessage
 * @property {(press: CollectedPress, recentPresses: CollectedPress[]) => void=} onPress
 */

class CC1101SegmentCollector {
  /**
   * @param {SegmentCollectorOptions=} options
   */
  constructor(options = {}) {
    this.options = {
      bus: options.bus ?? 0,
      device: options.device ?? 0,
      speedHz: options.speedHz ?? 100000,
      gdo0: options.gdo0 ?? 24,
      threshold: options.threshold ?? 100,
      baseUs: options.baseUs ?? 400,
      historyMs: options.historyMs ?? 2500,
      lookbackMs: options.lookbackMs ?? 500,
      settleMs: options.settleMs ?? 500,
      cooldownMs: options.cooldownMs ?? 500,
      pollMs: options.pollMs ?? 5,
      minDtUs: options.minDtUs ?? 20,
      silenceUnits: options.silenceUnits ?? 10,
      minSegmentEdges: options.minSegmentEdges ?? 6,
      niceSnap: options.niceSnap ?? true,
      keepPresses: options.keepPresses ?? 10,
      onMessage: options.onMessage ?? ((message) => console.log(message)),
      onPress: options.onPress ?? ((press, recentPresses) => {
        this.options.onMessage("============================================================");
        this.options.onMessage(`PRESS ${press.id}   ts=${press.ts}   triggerRSSI=${press.triggerRssi}`);
        this.options.onMessage(`baseUs=${press.baseUs}   segments=${press.segments.length}`);
        this.options.onMessage("");

        press.segments.forEach((segment, idx) => {
          const units = segment.map((edge) => edge.units);
          const durations = segment.map((edge) => edge.dtUs);
          const levels = segment.map((edge) => edge.level);

          this.options.onMessage(`segment ${idx + 1}   score=${scoreSegment(segment)}   edges=${segment.length}`);
          this.options.onMessage(`  levels:    ${levels.join(",")}`);
          this.options.onMessage(`  durations: ${durations.join(",")}`);
          this.options.onMessage(`  units:     ${units.join(",")}`);
          this.options.onMessage(`  compact:   ${compactFrame(segment)}`);
          this.options.onMessage(`  bars:      ${renderBars(units)}`);
          this.options.onMessage("");
        });

        this.options.onMessage("######################## RECENT SUMMARY ########################");
        recentPresses.forEach((recent) => {
          this.options.onMessage(`press ${recent.id}  RSSI=${recent.triggerRssi}  segs=${recent.segments.length}`);
          recent.segments.forEach((segment, idx) => {
            this.options.onMessage(
              `  s${idx + 1}  score=${String(scoreSegment(segment)).padStart(2, " ")}  edges=${String(segment.length).padStart(2, " ")}  compact=${compactFrame(segment)}  bars=${renderBars(segment.map((edge) => edge.units), 42)}`
            );
          });
          this.options.onMessage("");
        });
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
    /** @type {CollectedPress[]} */
    this.recentPresses = [];
  }

  async getRssiRaw() {
    if (!this.radio) throw new Error("Segment collector radio is not initialized");
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
    this.recentPresses = [];

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
      modulation: MODULATION.OOK,
      mode: RADIO_MODE.DIRECT_ASYNC,
    });
    await sleep(100);

    this.options.onMessage(
      `segment collector started gdo0=${this.options.gdo0} threshold=${this.options.threshold} baseUs=${this.options.baseUs} lookbackMs=${this.options.lookbackMs} settleMs=${this.options.settleMs} silenceUnits=${this.options.silenceUnits}`
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
        this.pendingTrigger = {
          triggerTimeMs: now,
          triggerRssi: rssi,
        };
        this.options.onMessage(`trigger rssi=${rssi}`);
      }

      if (this.pendingTrigger && now - this.pendingTrigger.triggerTimeMs >= this.options.settleMs) {
        const relevant = this.edges.filter((edge) => edge.wallclockMs >= this.pendingTrigger.triggerTimeMs - this.options.lookbackMs);
        const quantized = quantizeEdges(relevant, this.options.baseUs, this.options.niceSnap);
        const segments = splitBySilence(quantized, this.options.silenceUnits)
          .filter((segment) => segment.length >= this.options.minSegmentEdges);

        const press = {
          id: ++this.pressId,
          ts: new Date().toISOString(),
          triggerRssi: this.pendingTrigger.triggerRssi,
          baseUs: this.options.baseUs,
          segments,
        };

        this.recentPresses.push(press);
        while (this.recentPresses.length > this.options.keepPresses) {
          this.recentPresses.shift();
        }

        this.options.onPress(press, [...this.recentPresses]);
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
  CC1101SegmentCollector,
};
