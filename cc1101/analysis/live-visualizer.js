// @ts-check

const { Gpio } = require("pigpio");
const { CC1101Driver } = require("../driver");
const { STATUS, VALUE } = require("../constants");
const { BAND, MODULATION, RADIO_MODE } = require("../profiles");
const { sleep } = require("../utils");
const { clamp, trimHistory } = require("./signal-analysis");

const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const CURSOR_HOME = "\x1b[H";
const CLEAR_LINE = "\x1b[2K";

/**
 * @typedef {{ t: number, v: number }} TimedSample
 * @typedef {{ start: number, end: number }} TriggerWindow
 *
 * @typedef {object} LiveVisualizerOptions
 * @property {number=} bus
 * @property {number=} device
 * @property {number=} speedHz
 * @property {number=} gdo0
 * @property {number=} gdo2
 * @property {number=} threshold
 * @property {number=} windowMs
 * @property {number=} redrawMs
 * @property {number=} pollMs
 * @property {number=} triggerHoldMs
 * @property {number=} minDtUs
 * @property {number=} width
 * @property {number=} rows
 * @property {number=} minRssi
 * @property {number=} maxRssi
 * @property {(message: string) => void=} onMessage
 * @property {(screen: string) => void=} onRender
 */

function color(text, code) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

/**
 * @param {TimedSample[]} history
 * @param {number} defaultValue
 * @param {number} timeMs
 * @returns {number}
 */
function getStateAt(history, defaultValue, timeMs) {
  let state = defaultValue;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].t <= timeMs) {
      state = history[i].v;
      break;
    }
  }
  return state;
}

/**
 * @param {{
 *   label: string,
 *   history: TimedSample[],
 *   defaultValue: number,
 *   width: number,
 *   windowMs: number,
 *   now: number,
 *   onChar: string,
 *   offChar: string,
 *   triggerWindows: TriggerWindow[],
 *   onColor?: string,
 *   offColor?: string,
 *   triggerColor?: string,
 * }} options
 * @returns {string}
 */
function buildLine(options) {
  let line = options.label.padEnd(8, " ");

  for (let x = 0; x < options.width; x += 1) {
    const t = options.now - options.windowMs + Math.round((x / Math.max(1, options.width - 1)) * options.windowMs);
    const state = getStateAt(options.history, options.defaultValue, t);
    const inTrigger = options.triggerWindows.some((window) => t >= window.start && t <= window.end);
    const char = state ? options.onChar : options.offChar;

    if (inTrigger) {
      line += color(char, options.triggerColor ?? "31");
    } else {
      line += color(char, state ? (options.onColor ?? "37") : (options.offColor ?? "90"));
    }
  }

  return line;
}

/**
 * @param {{
 *   label: string,
 *   samples: TimedSample[],
 *   width: number,
 *   windowMs: number,
 *   now: number,
 *   minRssi: number,
 *   maxRssi: number,
 *   threshold: number,
 * }} options
 * @returns {string}
 */
function buildRssiLine(options) {
  const blocks = " ▁▂▃▄▅▆▇█";
  let line = options.label.padEnd(8, " ");

  for (let x = 0; x < options.width; x += 1) {
    const t = options.now - options.windowMs + Math.round((x / Math.max(1, options.width - 1)) * options.windowMs);
    let sample = null;

    for (let i = options.samples.length - 1; i >= 0; i -= 1) {
      if (options.samples[i].t <= t) {
        sample = options.samples[i].v;
        break;
      }
    }

    if (sample === null) {
      line += color(" ", "90");
      continue;
    }

    const norm = clamp((sample - options.minRssi) / Math.max(1, options.maxRssi - options.minRssi), 0, 1);
    const idx = clamp(Math.round(norm * (blocks.length - 1)), 0, blocks.length - 1);
    const char = blocks[idx];
    line += color(char, sample < options.threshold ? "31" : "36");
  }

  return line;
}

/**
 * @param {{
 *   label: string,
 *   width: number,
 *   windowMs: number,
 *   now: number,
 *   triggerWindows: TriggerWindow[],
 * }} options
 * @returns {string}
 */
function buildTriggerLine(options) {
  let line = options.label.padEnd(8, " ");

  for (let x = 0; x < options.width; x += 1) {
    const t = options.now - options.windowMs + Math.round((x / Math.max(1, options.width - 1)) * options.windowMs);
    const inTrigger = options.triggerWindows.some((window) => t >= window.start && t <= window.end);
    line += inTrigger ? color("■", "31") : color("·", "90");
  }

  return line;
}

/**
 * @param {{
 *   label: string,
 *   history: TimedSample[],
 *   defaultValue: number,
 *   width: number,
 *   startMs: number,
 *   endMs: number,
 *   triggerWindows: TriggerWindow[],
 *   onChar: string,
 *   offChar: string,
 *   onColor?: string,
 *   offColor?: string,
 *   triggerColor?: string,
 * }} options
 * @returns {string}
 */
function buildWindowLine(options) {
  let line = options.label.padEnd(8, " ");
  const spanMs = Math.max(1, options.endMs - options.startMs);

  for (let x = 0; x < options.width; x += 1) {
    const t = options.startMs + Math.round((x / Math.max(1, options.width - 1)) * spanMs);
    const state = getStateAt(options.history, options.defaultValue, t);
    const inTrigger = options.triggerWindows.some((window) => t >= window.start && t <= window.end);
    const char = state ? options.onChar : options.offChar;

    if (inTrigger) {
      line += color(char, options.triggerColor ?? "31");
    } else {
      line += color(char, state ? (options.onColor ?? "37") : (options.offColor ?? "90"));
    }
  }

  return line;
}

/**
 * @param {number} now
 * @param {number} endMs
 * @returns {string}
 */
function formatAgo(now, endMs) {
  const delta = Math.max(0, now - endMs);
  if (delta < 1000) return `${delta}ms`;
  return `${(delta / 1000).toFixed(1)}s`;
}

class CC1101LiveVisualizer {
  /**
   * @param {LiveVisualizerOptions=} options
   */
  constructor(options = {}) {
    this.options = {
      bus: options.bus ?? 0,
      device: options.device ?? 0,
      speedHz: options.speedHz ?? 100000,
      gdo0: options.gdo0 ?? 24,
      gdo2: options.gdo2 ?? 25,
      threshold: options.threshold ?? 100,
      windowMs: options.windowMs ?? 3000,
      redrawMs: options.redrawMs ?? 80,
      pollMs: options.pollMs ?? 20,
      triggerHoldMs: options.triggerHoldMs ?? 250,
      minDtUs: options.minDtUs ?? 20,
      width: options.width ?? 100,
      rows: options.rows ?? 6,
      minRssi: options.minRssi ?? 0,
      maxRssi: options.maxRssi ?? 255,
      onMessage: options.onMessage ?? ((message) => console.log(message)),
      onRender: options.onRender ?? ((screen) => {
        process.stdout.write(screen);
      }),
    };

    this.radio = null;
    this.gdo0Pin = null;
    this.gdo2Pin = null;
    this.pollPromise = null;
    this.renderPromise = null;
    this.stopping = false;
    this.gdo0State = 0;
    this.gdo2State = 0;
    this.lastGdo0Tick = 0;
    /** @type {TimedSample[]} */
    this.gdo0History = [];
    /** @type {TimedSample[]} */
    this.gdo2History = [];
    /** @type {TimedSample[]} */
    this.rssiHistory = [];
    /** @type {TriggerWindow[]} */
    this.triggerWindows = [];
    this.lastScreen = "";
    this.screenLineCount = 0;
    this.dirty = true;
    this.ownsScreen = false;
  }

  async getRssiRaw() {
    if (!this.radio) throw new Error("Live visualizer radio is not initialized");
    return this.radio.readRegister(STATUS.RSSI);
  }

  addTrigger(now) {
    this.triggerWindows.push({ start: now, end: now + this.options.triggerHoldMs });
    this.dirty = true;
  }

  cleanupOld(now) {
    const cutoff = now - this.options.windowMs - 1000;
    trimHistory(this.gdo0History.map((entry) => ({ ...entry, wallclockMs: entry.t })), this.options.windowMs + 1000);
    trimHistory(this.gdo2History.map((entry) => ({ ...entry, wallclockMs: entry.t })), this.options.windowMs + 1000);
    trimHistory(this.rssiHistory.map((entry) => ({ ...entry, wallclockMs: entry.t })), this.options.windowMs + 1000);
    while (this.gdo0History.length && this.gdo0History[0].t < cutoff) this.gdo0History.shift();
    while (this.gdo2History.length && this.gdo2History[0].t < cutoff) this.gdo2History.shift();
    while (this.rssiHistory.length && this.rssiHistory[0].t < cutoff) this.rssiHistory.shift();
    while (this.triggerWindows.length && this.triggerWindows[0].end < cutoff) this.triggerWindows.shift();
  }

  buildScreen(now) {
    const lines = [];
    const rowCount = Math.max(2, this.options.rows);
    const rowWindowMs = Math.max(100, Math.round(this.options.windowMs / rowCount));

    lines.push(`GDO live waveform view  |  window=${this.options.windowMs}ms  threshold=${this.options.threshold}  gdo0=${this.options.gdo0}  gdo2=${this.options.gdo2}`);
    lines.push(color("red = trigger window, cyan = RSSI, green/yellow = active, gray = idle", "90"));
    lines.push(color(`rows show recent ${rowWindowMs}ms slices from oldest to newest`, "90"));
    lines.push("");
    lines.push(buildLine({
      label: "GDO0 H/L",
      history: this.gdo0History,
      defaultValue: 0,
      width: this.options.width,
      windowMs: this.options.windowMs,
      now,
      onChar: "█",
      offChar: "_",
      triggerWindows: this.triggerWindows,
      onColor: "32",
      offColor: "90",
      triggerColor: "31",
    }));
    lines.push(buildLine({
      label: "GDO2 PQI",
      history: this.gdo2History,
      defaultValue: 0,
      width: this.options.width,
      windowMs: this.options.windowMs,
      now,
      onChar: "█",
      offChar: "_",
      triggerWindows: this.triggerWindows,
      onColor: "33",
      offColor: "90",
      triggerColor: "31",
    }));
    lines.push(buildRssiLine({
      label: "RSSI",
      samples: this.rssiHistory,
      width: this.options.width,
      windowMs: this.options.windowMs,
      now,
      minRssi: this.options.minRssi,
      maxRssi: this.options.maxRssi,
      threshold: this.options.threshold,
    }));
    lines.push(buildTriggerLine({
      label: "TRIGGER",
      width: this.options.width,
      windowMs: this.options.windowMs,
      now,
      triggerWindows: this.triggerWindows,
    }));
    lines.push("");

    lines.push(color("Recent GDO0 slices", "35"));
    for (let row = 0; row < rowCount; row += 1) {
      const startMs = now - this.options.windowMs + (row * rowWindowMs);
      const endMs = row === rowCount - 1 ? now : startMs + rowWindowMs;
      const ageLabel = formatAgo(now, endMs).padStart(6, " ");
      lines.push(buildWindowLine({
        label: ageLabel,
        history: this.gdo0History,
        defaultValue: 0,
        width: this.options.width,
        startMs,
        endMs,
        triggerWindows: this.triggerWindows,
        onChar: "▀",
        offChar: "·",
        onColor: "32",
        offColor: "90",
        triggerColor: "31",
      }));
    }
    lines.push("");

    lines.push(color("Recent GDO2 slices", "35"));
    for (let row = 0; row < rowCount; row += 1) {
      const startMs = now - this.options.windowMs + (row * rowWindowMs);
      const endMs = row === rowCount - 1 ? now : startMs + rowWindowMs;
      const ageLabel = formatAgo(now, endMs).padStart(6, " ");
      lines.push(buildWindowLine({
        label: ageLabel,
        history: this.gdo2History,
        defaultValue: 0,
        width: this.options.width,
        startMs,
        endMs,
        triggerWindows: this.triggerWindows,
        onChar: "▀",
        offChar: "·",
        onColor: "33",
        offColor: "90",
        triggerColor: "31",
      }));
    }
    lines.push("");

    const lastRssi = this.rssiHistory.length ? this.rssiHistory[this.rssiHistory.length - 1].v : "n/a";
    const activeTriggers = this.triggerWindows.filter((window) => now >= window.start && now <= window.end).length;
    lines.push(`Current RSSI: ${lastRssi}   GDO0: ${this.gdo0State}   GDO2: ${this.gdo2State}   Active trigger windows: ${activeTriggers}`);
    lines.push("Newest slice is at the bottom. Repeated presses should produce similar row shapes.");

    return lines;
  }

  handleGdo0Alert(level, tick) {
    if (this.stopping) {
      this.lastGdo0Tick = tick;
      return;
    }

    if (this.lastGdo0Tick === 0) {
      this.lastGdo0Tick = tick;
      this.gdo0State = level;
      this.gdo0History.push({ t: Date.now(), v: level });
      this.dirty = true;
      return;
    }

    let dtUs = tick - this.lastGdo0Tick;
    if (dtUs < 0) dtUs += 0x100000000;
    this.lastGdo0Tick = tick;
    if (dtUs < this.options.minDtUs) return;

    this.gdo0State = level;
    this.gdo0History.push({ t: Date.now(), v: level });
    this.dirty = true;
  }

  handleGdo2Alert(level) {
    if (this.stopping) return;
    this.gdo2State = level;
    this.gdo2History.push({ t: Date.now(), v: level });
    this.dirty = true;
  }

  renderScreen(lines) {
    const width = process.stdout.columns || this.options.width + 16;
    const normalized = lines.map((line) => {
      const clipped = line.length > width ? line.slice(0, width) : line;
      return `${CLEAR_LINE}${clipped}`;
    });

    while (normalized.length < this.screenLineCount) {
      normalized.push(CLEAR_LINE);
    }

    const output = `${CURSOR_HOME}${normalized.join("\n")}`;
    const rendered = normalized.join("\n");

    if (rendered === this.lastScreen) {
      return;
    }

    this.lastScreen = rendered;
    this.screenLineCount = normalized.length;
    this.options.onRender(output);
  }

  async start() {
    if (this.pollPromise || this.renderPromise) return;

    this.stopping = false;
    this.gdo0State = 0;
    this.gdo2State = 0;
    this.lastGdo0Tick = 0;
    this.gdo0History = [{ t: Date.now(), v: 0 }];
    this.gdo2History = [{ t: Date.now(), v: 0 }];
    this.rssiHistory = [];
    this.triggerWindows = [];
    this.lastScreen = "";
    this.screenLineCount = 0;
    this.dirty = true;

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
        gdo2: VALUE.IOCFG.PQI,
      },
    });
    await sleep(100);

    process.stdout.write(ALT_SCREEN_ON);
    process.stdout.write(CURSOR_HIDE);
    process.stdout.write(CURSOR_HOME);
    this.ownsScreen = true;

    this.gdo0Pin.on("alert", (level, tick) => this.handleGdo0Alert(level, tick));
    this.gdo2Pin.on("alert", (level) => this.handleGdo2Alert(level));
    this.pollPromise = this.runPollLoop().finally(() => {
      this.pollPromise = null;
    });
    this.renderPromise = this.runRenderLoop().finally(() => {
      this.renderPromise = null;
    });
  }

  async runPollLoop() {
    while (!this.stopping) {
      const now = Date.now();
      const rssi = await this.getRssiRaw().catch(() => null);

      if (rssi !== null) {
        this.rssiHistory.push({ t: now, v: rssi });
        this.dirty = true;
        if (rssi < this.options.threshold) {
          this.addTrigger(now);
        }
      }

      this.cleanupOld(now);
      await sleep(this.options.pollMs);
    }
  }

  async runRenderLoop() {
    while (!this.stopping) {
      const now = Date.now();
      this.cleanupOld(now);
      if (this.dirty) {
        this.renderScreen(this.buildScreen(now));
        this.dirty = false;
      }
      await sleep(this.options.redrawMs);
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

    if (this.radio) {
      try {
        await this.radio.idle();
      } catch {}

      try {
        await this.radio.close();
      } catch {}
      this.radio = null;
    }

    if (this.pollPromise) await this.pollPromise.catch(() => {});
    if (this.renderPromise) await this.renderPromise.catch(() => {});

    if (this.ownsScreen) {
      process.stdout.write(CURSOR_SHOW);
      process.stdout.write(ALT_SCREEN_OFF);
      this.ownsScreen = false;
    }
  }
}

module.exports = {
  CC1101LiveVisualizer,
};
