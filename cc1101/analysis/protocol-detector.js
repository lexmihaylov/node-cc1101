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
  detectProtocolCandidates,
} = require("./protocol-analysis");

/**
 * @typedef {import("./protocol-analysis").ProtocolCandidate} ProtocolCandidate
 *
 * @typedef {object} ProtocolPress
 * @property {number} id
 * @property {string} ts
 * @property {number} triggerRssi
 *
 * @typedef {object} ProtocolDetectorOptions
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
 * @property {number=} minFrameEdges
 * @property {number=} maxFrameEdges
 * @property {number=} silenceUnits
 * @property {number=} maxFrames
 * @property {boolean=} niceSnap
 * @property {number | null=} rssiTolerance
 * @property {(message: string) => void=} onMessage
 * @property {(press: ProtocolPress, candidate: ProtocolCandidate) => void=} onCandidate
 *
 * @typedef {object} ProtocolDetectorState
 * @property {number} pressId
 * @property {number} cooldownUntil
 * @property {{ triggerTimeMs: number, triggerRssi: number } | null} pendingTrigger
 * @property {number} lastTick
 * @property {boolean} stopping
 */

function trimHistory(edges, historyMs) {
  const cutoff = Date.now() - historyMs;
  while (edges.length && edges[0].wallclockMs < cutoff) {
    edges.shift();
  }
}

class CC1101ProtocolDetector {
  /**
   * @param {ProtocolDetectorOptions=} options
   */
  constructor(options = {}) {
    this.options = {
      bus: options.bus ?? 0,
      device: options.device ?? 0,
      speedHz: options.speedHz ?? 100000,
      gdo0: options.gdo0 ?? 24,
      threshold: options.threshold ?? 100,
      baseUs: options.baseUs ?? 375,
      historyMs: options.historyMs ?? 2500,
      lookbackMs: options.lookbackMs ?? 500,
      settleMs: options.settleMs ?? 500,
      cooldownMs: options.cooldownMs ?? 500,
      pollMs: options.pollMs ?? 5,
      minDtUs: options.minDtUs ?? 20,
      minFrameEdges: options.minFrameEdges ?? 12,
      maxFrameEdges: options.maxFrameEdges ?? 40,
      silenceUnits: options.silenceUnits ?? 10,
      maxFrames: options.maxFrames ?? 4,
      niceSnap: options.niceSnap ?? true,
      rssiTolerance: options.rssiTolerance ?? null,
      onMessage: options.onMessage ?? ((message) => console.log(message)),
      onCandidate: options.onCandidate ?? ((press, candidate) => {
        const units = candidate.frame.map((edge) => edge.units);
        const best = candidate.rankings[0];
        const second = candidate.rankings[1];

        this.options.onMessage("---- protocol detection ----");
        this.options.onMessage(`press:        ${press.id}`);
        this.options.onMessage(`ts:           ${press.ts}`);
        this.options.onMessage(`triggerRSSI:  ${press.triggerRssi}`);
        this.options.onMessage(`frameScore:   ${candidate.frameScore}`);
        this.options.onMessage(`edges:        ${candidate.frame.length}`);
        this.options.onMessage(`units:        ${units.join(",")}`);
        this.options.onMessage(`compact:      ${compactFrame(candidate.frame)}`);
        for (const line of renderSignalSummary({
          label: "candidate",
          units,
          levels: candidate.frame.map((edge) => edge.level),
          durationsUs: candidate.frame.map((edge) => edge.dtUs),
          snappedUs: candidate.frame.map((edge) => edge.snappedUs),
        })) {
          this.options.onMessage(line);
        }
        this.options.onMessage("");
        this.options.onMessage(`bestMatch:    ${best.name} (${best.score.toFixed(1)})`);
        this.options.onMessage(`details:      ${best.details}`);
        if (best.bits) {
          this.options.onMessage(`bits?:        ${best.bits}`);
        }
        if (second) {
          this.options.onMessage(`runnerUp:     ${second.name} (${second.score.toFixed(1)})`);
        }
        this.options.onMessage("");
        this.options.onMessage("rankings:");
        for (const ranking of candidate.rankings) {
          this.options.onMessage(`  - ${ranking.name.padEnd(20)} ${ranking.score.toFixed(1)}   ${ranking.details}`);
        }
        this.options.onMessage("");
      }),
    };

    this.radio = null;
    this.gdo0Pin = null;
    this.edges = [];
    this.loopPromise = null;
    /** @type {ProtocolDetectorState} */
    this.state = {
      pressId: 0,
      cooldownUntil: 0,
      pendingTrigger: null,
      lastAcceptedTriggerRssi: null,
      lastTick: 0,
      stopping: false,
    };
  }

  async getRssiRaw() {
    if (!this.radio) {
      throw new Error("Protocol detector radio is not initialized");
    }

    return this.radio.readRegister(STATUS.RSSI);
  }

  handleAlert(level, tick) {
    if (this.state.stopping) {
      this.state.lastTick = tick;
      return;
    }

    if (this.state.lastTick === 0) {
      this.state.lastTick = tick;
      return;
    }

    let dtUs = tick - this.state.lastTick;
    if (dtUs < 0) dtUs += 0x100000000;
    this.state.lastTick = tick;

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

    this.state.stopping = false;
    this.edges = [];
    this.state.lastTick = 0;
    this.state.pendingTrigger = null;
    this.state.cooldownUntil = 0;
    this.state.lastAcceptedTriggerRssi = null;

    this.radio = new CC1101Driver({
      bus: this.options.bus,
      device: this.options.device,
      speedHz: this.options.speedHz,
    });

    this.gdo0Pin = new Gpio(this.options.gdo0, {
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
      `protocol detector started gdo0=${this.options.gdo0} threshold=${this.options.threshold} baseUs=${this.options.baseUs} lookbackMs=${this.options.lookbackMs} settleMs=${this.options.settleMs} rssiTolerance=${this.options.rssiTolerance ?? "off"}`
    );

    this.gdo0Pin.on("alert", (level, tick) => this.handleAlert(level, tick));
    this.loopPromise = this.runLoop().finally(() => {
      this.loopPromise = null;
    });
  }

  async runLoop() {
    while (!this.state.stopping) {
      const now = Date.now();
      const rssi = await this.getRssiRaw().catch(() => null);

      if (
        !this.state.pendingTrigger &&
        now >= this.state.cooldownUntil &&
        rssi !== null &&
        rssi < this.options.threshold
      ) {
        if (!shouldAcceptTriggerRssi(this.state.lastAcceptedTriggerRssi, rssi, this.options.rssiTolerance)) {
          this.options.onMessage(
            `ignored rssi=${rssi} reference=${this.state.lastAcceptedTriggerRssi} tolerance=${this.options.rssiTolerance}`
          );
          this.state.cooldownUntil = now + 100;
          await sleep(this.options.pollMs);
          continue;
        }
        this.state.pendingTrigger = {
          triggerTimeMs: now,
          triggerRssi: rssi,
        };
        this.options.onMessage(`trigger rssi=${rssi}`);
      }

      if (
        this.state.pendingTrigger &&
        now - this.state.pendingTrigger.triggerTimeMs >= this.options.settleMs
      ) {
        const relevant = this.edges.filter(
          (edge) => edge.wallclockMs >= this.state.pendingTrigger.triggerTimeMs - this.options.lookbackMs
        );

        if (relevant.length >= this.options.minFrameEdges) {
          const candidates = detectProtocolCandidates(relevant, {
            baseUs: this.options.baseUs,
            minFrameEdges: this.options.minFrameEdges,
            maxFrameEdges: this.options.maxFrameEdges,
            silenceUnits: this.options.silenceUnits,
            maxFrames: this.options.maxFrames,
            niceSnap: this.options.niceSnap,
          });

          if (candidates.length) {
            const press = {
              id: ++this.state.pressId,
              ts: new Date().toISOString(),
              triggerRssi: this.state.pendingTrigger.triggerRssi,
            };

            for (const candidate of candidates) {
              this.options.onCandidate(press, candidate);
            }

            this.state.lastAcceptedTriggerRssi = this.state.pendingTrigger.triggerRssi;
          }
        }

        this.state.pendingTrigger = null;
        this.state.cooldownUntil = now + this.options.cooldownMs;
      }

      await sleep(this.options.pollMs);
    }
  }

  async stop() {
    this.state.stopping = true;

    if (this.gdo0Pin) {
      try {
        this.gdo0Pin.disableAlert();
      } catch {}
      this.gdo0Pin = null;
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
  CC1101ProtocolDetector,
};
