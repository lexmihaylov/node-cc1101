// @ts-check

const { Gpio } = require("pigpio");
const { CC1101Driver } = require("../driver");
const { STATUS } = require("../constants");
const { BAND, GDO_SIGNAL, MODULATION, RADIO_MODE } = require("../profiles");
const { sleep } = require("../utils");
const { renderSignalSummary } = require("./signal-renderer");
const {
  estimateBaseUnit,
  normalizeToUnits,
  classifyUnit,
} = require("./raw-analysis");

/**
 * @typedef {object} ExtractedFrame
 * @property {number} id
 * @property {string} ts
 * @property {string} reason
 * @property {number} triggerRssi
 * @property {number | null} rssiBefore
 * @property {number | null} rssiAfter
 * @property {boolean} gdo2Seen
 * @property {number} startIndex
 * @property {number} endIndex
 * @property {number[]} levels
 * @property {number[]} durationsUs
 *
 * @typedef {object} FrameExtractorOptions
 * @property {number=} bus
 * @property {number=} device
 * @property {number=} speedHz
 * @property {number=} gdo0
 * @property {number=} gdo2
 * @property {number=} threshold
 * @property {number=} silenceGapUs
 * @property {number=} minEdges
 * @property {number=} cooldownMs
 * @property {number=} historyMs
 * @property {number=} postTriggerTimeoutMs
 * @property {number=} pollMs
 * @property {number=} minDtUs
 * @property {number=} segmentGapUnits
 * @property {(message: string) => void=} onMessage
 * @property {(frame: ExtractedFrame) => void=} onFrame
 */

function compactUnits(units) {
  return units.map(classifyUnit).join("");
}

function splitByLargeGaps(durationsUs, levels, gapUnits, baseUnitUs) {
  const units = normalizeToUnits(durationsUs, baseUnitUs);
  const segments = [];
  let currentDurations = [];
  let currentLevels = [];
  let currentUnits = [];

  for (let i = 0; i < units.length; i += 1) {
    if (units[i] > gapUnits) {
      if (currentUnits.length) {
        segments.push({
          durationsUs: currentDurations,
          levels: currentLevels,
          units: currentUnits,
        });
        currentDurations = [];
        currentLevels = [];
        currentUnits = [];
      }
      continue;
    }

    currentDurations.push(durationsUs[i]);
    currentLevels.push(levels[i]);
    currentUnits.push(units[i]);
  }

  if (currentUnits.length) {
    segments.push({
      durationsUs: currentDurations,
      levels: currentLevels,
      units: currentUnits,
    });
  }

  return segments;
}

class CC1101FrameExtractor {
  /**
   * @param {FrameExtractorOptions=} options
   */
  constructor(options = {}) {
    this.options = {
      bus: options.bus ?? 0,
      device: options.device ?? 0,
      speedHz: options.speedHz ?? 100000,
      gdo0: options.gdo0 ?? 24,
      gdo2: options.gdo2 ?? 25,
      threshold: options.threshold ?? 100,
      silenceGapUs: options.silenceGapUs ?? 8000,
      minEdges: options.minEdges ?? 12,
      cooldownMs: options.cooldownMs ?? 250,
      historyMs: options.historyMs ?? 1500,
      postTriggerTimeoutMs: options.postTriggerTimeoutMs ?? 500,
      pollMs: options.pollMs ?? 5,
      minDtUs: options.minDtUs ?? 20,
      segmentGapUnits: options.segmentGapUnits ?? 20,
      onMessage: options.onMessage ?? ((message) => console.log(message)),
      onFrame: options.onFrame ?? ((frame) => {
        const baseUnitUs = estimateBaseUnit(frame.durationsUs);
        const units = normalizeToUnits(frame.durationsUs, baseUnitUs);
        const compact = compactUnits(units);
        const segments = splitByLargeGaps(
          frame.durationsUs,
          frame.levels,
          this.options.segmentGapUnits,
          baseUnitUs
        );

        this.options.onMessage("---- extracted frame ----");
        this.options.onMessage(`id:           ${frame.id}`);
        this.options.onMessage(`ts:           ${frame.ts}`);
        this.options.onMessage(`reason:       ${frame.reason}`);
        this.options.onMessage(`triggerRSSI:  ${frame.triggerRssi}`);
        this.options.onMessage(`rssiBefore:   ${frame.rssiBefore ?? "n/a"}`);
        this.options.onMessage(`rssiAfter:    ${frame.rssiAfter ?? "n/a"}`);
        this.options.onMessage(`gdo2Seen:     ${frame.gdo2Seen}`);
        this.options.onMessage(`startIndex:   ${frame.startIndex}`);
        this.options.onMessage(`endIndex:     ${frame.endIndex}`);
        this.options.onMessage(`edges:        ${frame.durationsUs.length}`);
        this.options.onMessage(`baseUnit:     ~${baseUnitUs} us`);
        this.options.onMessage(`levels:       ${frame.levels.join(",")}`);
        this.options.onMessage(`durations:    ${frame.durationsUs.join(",")}`);
        this.options.onMessage(`units:        ${units.join(",")}`);
        this.options.onMessage(`compact:      ${compact}`);
        for (const line of renderSignalSummary({
          label: "frame",
          units,
          levels: frame.levels,
          durationsUs: frame.durationsUs,
        })) {
          this.options.onMessage(`${line}`);
        }
        this.options.onMessage("");

        segments.forEach((segment, idx) => {
          this.options.onMessage(`  segment ${idx + 1}`);
          this.options.onMessage(`    levels:    ${segment.levels.join(",")}`);
          this.options.onMessage(`    durations: ${segment.durationsUs.join(",")}`);
          this.options.onMessage(`    units:     ${segment.units.join(",")}`);
          this.options.onMessage(`    compact:   ${compactUnits(segment.units)}`);
          for (const line of renderSignalSummary({
            label: `segment ${idx + 1}`,
            units: segment.units,
            levels: segment.levels,
            durationsUs: segment.durationsUs,
          })) {
            this.options.onMessage(`    ${line}`);
          }
        });

        if (segments.length) this.options.onMessage("");
      }),
    };

    this.radio = null;
    this.gdo0Pin = null;
    this.gdo2Pin = null;
    this.loopPromise = null;
    this.stopping = false;
    this.frameId = 0;
    this.lastGdo0Tick = 0;
    this.edges = [];
    this.gdo2Events = [];
    this.gdo2Active = false;
    this.pendingTrigger = null;
    this.cooldownUntil = 0;
  }

  trimHistory() {
    const cutoff = Date.now() - this.options.historyMs;
    while (this.edges.length && this.edges[0].wallclockMs < cutoff) {
      this.edges.shift();
    }
    while (this.gdo2Events.length && this.gdo2Events[0].wallclockMs < cutoff) {
      this.gdo2Events.shift();
    }
  }

  findPreviousSilence(triggerIndex) {
    for (let i = triggerIndex; i >= 0; i -= 1) {
      if (this.edges[i].dtUs >= this.options.silenceGapUs) {
        return i + 1;
      }
    }
    return 0;
  }

  findNextSilence(triggerIndex) {
    for (let i = triggerIndex; i < this.edges.length; i += 1) {
      if (this.edges[i].dtUs >= this.options.silenceGapUs) {
        return i - 1;
      }
    }
    return -1;
  }

  wasGdo2SeenBetween(startMs, endMs) {
    return this.gdo2Events.some((event) =>
      event.level === 1 && event.wallclockMs >= startMs && event.wallclockMs <= endMs
    );
  }

  extractFrame(triggerIndex, triggerRssi, rssiBefore, rssiAfter) {
    const startIndex = this.findPreviousSilence(triggerIndex);
    const endIndex = this.findNextSilence(triggerIndex);

    if (endIndex < startIndex) return null;

    const slice = this.edges.slice(startIndex, endIndex + 1);
    if (slice.length < this.options.minEdges) return null;

    const startMs = slice[0].wallclockMs;
    const endMs = slice[slice.length - 1].wallclockMs;

    return {
      id: ++this.frameId,
      ts: new Date().toISOString(),
      reason: "silence-before-after",
      triggerRssi,
      rssiBefore,
      rssiAfter,
      gdo2Seen: this.wasGdo2SeenBetween(startMs, endMs),
      startIndex,
      endIndex,
      levels: slice.map((edge) => edge.level),
      durationsUs: slice.map((edge) => edge.dtUs),
    };
  }

  async getRssiRaw() {
    if (!this.radio) throw new Error("Frame extractor radio is not initialized");
    return this.radio.readRegister(STATUS.RSSI);
  }

  handleGdo2Alert(level) {
    if (this.stopping) return;
    const now = Date.now();
    this.gdo2Active = level === 1;
    this.gdo2Events.push({
      level,
      wallclockMs: now,
    });
    this.trimHistory();
  }

  handleGdo0Alert(level, tick) {
    if (this.stopping) {
      this.lastGdo0Tick = tick;
      return;
    }

    if (this.lastGdo0Tick === 0) {
      this.lastGdo0Tick = tick;
      return;
    }

    let dtUs = tick - this.lastGdo0Tick;
    if (dtUs < 0) dtUs += 0x100000000;
    this.lastGdo0Tick = tick;

    if (dtUs < this.options.minDtUs) return;

    this.edges.push({
      level,
      dtUs,
      tick,
      wallclockMs: Date.now(),
    });

    this.trimHistory();
  }

  async start() {
    if (this.loopPromise) return;

    this.stopping = false;
    this.frameId = 0;
    this.lastGdo0Tick = 0;
    this.edges = [];
    this.gdo2Events = [];
    this.gdo2Active = false;
    this.pendingTrigger = null;
    this.cooldownUntil = 0;

    this.radio = new CC1101Driver({
      bus: this.options.bus,
      device: this.options.device,
      speedHz: this.options.speedHz,
    });
    this.gdo0Pin = new Gpio(this.options.gdo0, { mode: Gpio.INPUT, alert: true });
    this.gdo2Pin = new Gpio(this.options.gdo2, { mode: Gpio.INPUT, alert: true });

    await this.radio.open();
    await this.radio.reset();
    await this.radio.verifyChip();
    await this.radio.startDirectAsyncRx({
      band: BAND.MHZ_433,
      modulation: MODULATION.OOK,
      mode: RADIO_MODE.DIRECT_ASYNC,
      gpio: {
        gdo0: GDO_SIGNAL.ASYNC_SERIAL_DATA,
        gdo2: GDO_SIGNAL.PQI,
      },
      packet: {
        appendStatus: false,
      },
    });
    await sleep(100);

    this.options.onMessage(
      `frame extractor started gdo0=${this.options.gdo0} gdo2=${this.options.gdo2} threshold=${this.options.threshold} silenceGapUs=${this.options.silenceGapUs} minEdges=${this.options.minEdges}`
    );

    this.gdo2Pin.on("alert", (level) => this.handleGdo2Alert(level));
    this.gdo0Pin.on("alert", (level, tick) => this.handleGdo0Alert(level, tick));
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
          triggerRssi: rssi,
          rssiBefore: rssi,
          triggerTimeMs: now,
          triggerEdgeIndex: Math.max(0, this.edges.length - 1),
        };
        this.options.onMessage(`trigger rssi=${rssi} gdo2=${this.gdo2Active ? 1 : 0}`);
      }

      if (this.pendingTrigger) {
        const triggerAge = now - this.pendingTrigger.triggerTimeMs;
        const afterSilenceFound = this.findNextSilence(this.pendingTrigger.triggerEdgeIndex) >= 0;

        if (afterSilenceFound) {
          const rssiAfter = await this.getRssiRaw().catch(() => null);
          const frame = this.extractFrame(
            this.pendingTrigger.triggerEdgeIndex,
            this.pendingTrigger.triggerRssi,
            this.pendingTrigger.rssiBefore,
            rssiAfter
          );

          if (frame) {
            this.options.onFrame(frame);
          }

          this.pendingTrigger = null;
          this.cooldownUntil = now + this.options.cooldownMs;
        } else if (triggerAge > this.options.postTriggerTimeoutMs) {
          this.pendingTrigger = null;
          this.cooldownUntil = now + 100;
        }
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

    if (this.gdo2Pin) {
      try {
        this.gdo2Pin.disableAlert();
      } catch {}
      this.gdo2Pin = null;
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
  CC1101FrameExtractor,
  compactUnits,
  splitByLargeGaps,
};
