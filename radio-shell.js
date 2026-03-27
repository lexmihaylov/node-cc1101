#!/usr/bin/env node

const fs = require("fs");
const readline = require("readline");
const appConfig = require("./config");
const { CC1101RawListener } = require("./cc1101/analysis/raw-listener");
const { CC1101StreamRecorder } = require("./cc1101/analysis/stream-recorder");
const {
  DEFAULT_MINIMUM_PULSE_WIDTH_US,
  loadCaptureFile,
  renderRawSignal,
  renderSegmentedFrames,
  summarizeCaptureFile,
} = require("./cc1101/analysis/capture-file");
const {
  buildReplayFromCapture,
  CC1101WindowReplayer,
} = require("./cc1101/analysis/window-replay");
const { CC1101Driver } = require("./cc1101/driver");
const { STATUS } = require("./cc1101/constants");
const {
  BAND,
  MODULATION,
  PACKET_LENGTH_MODE,
  RADIO_MODE,
} = require("./cc1101/profiles");
const { hex, parseArgs, parsePayload, sleep } = require("./cc1101/utils");

const MARCSTATE_MAP = {
  0x00: "SLEEP",
  0x01: "IDLE",
  0x0d: "RX",
  0x11: "RX_OVERFLOW",
  0x13: "TX",
  0x16: "TX_UNDERFLOW",
};

const COLOR = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  blue: "\u001b[34m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  magenta: "\u001b[35m",
};

const MANUALS = {
  help: [
    "NAME",
    "  help - show the short command list",
    "",
    "USAGE",
    "  help",
    "",
    "DESCRIPTION",
    "  Prints the compact command summary and a few example flows.",
    "  Use `man <command>` for detailed usage of a specific command.",
  ].join("\n"),
  man: [
    "NAME",
    "  man - show detailed shell command documentation",
    "",
    "USAGE",
    "  man",
    "  man <command>",
    "",
    "DESCRIPTION",
    "  Without arguments, lists the commands that have manual entries.",
    "  With a command name, prints detailed usage, behavior, and option meanings.",
    "",
    "EXAMPLES",
    "  man mode",
    "  man listen",
    "  man replay",
  ].join("\n"),
  connect: [
    "NAME",
    "  connect - open the SPI connection to the CC1101",
    "",
    "USAGE",
    "  connect [bus] [device] [speedHz]",
    "",
    "OPTIONS",
    "  bus",
    "    SPI bus number. Default is the current shell bus, usually 0.",
    "  device",
    "    SPI chip-select number. Default is the current shell device, usually 0.",
    "  speedHz",
    `    SPI clock speed in Hz. Default is the current shell speed, usually ${appConfig.spi.speedHz}.`,
    "",
    "DESCRIPTION",
    "  Reconnects the shell to the radio using the supplied SPI settings.",
    "  If the shell is already connected, it stops active work, closes the old connection,",
    "  and then opens a new one.",
  ].join("\n"),
  disconnect: [
    "NAME",
    "  disconnect - stop active work and close the SPI connection",
    "",
    "USAGE",
    "  disconnect",
    "",
    "DESCRIPTION",
    "  Stops packet listening or any direct-async runtime, idles the radio,",
    "  and closes the SPI device.",
  ].join("\n"),
  status: [
    "NAME",
    "  status - print current radio state and status registers",
    "",
    "USAGE",
    "  status",
    "",
    "DESCRIPTION",
    "  Prints MARCSTATE, RSSI, PKTSTATUS, RXBYTES, and TXBYTES.",
    "  Useful for confirming whether the radio is in IDLE, RX, or TX and whether",
    "  FIFO activity looks sane.",
  ].join("\n"),
  spectrum: [
    "NAME",
    "  spectrum - sweep a frequency range and render RSSI bars",
    "",
    "USAGE",
    "  spectrum [startMHz] [stopMHz] [stepKHz] [dwellMs] [samples]",
    "  spectrum live [startMHz] [stopMHz] [stepKHz] [dwellMs] [samples]",
    "",
    "OPTIONS",
    "  startMHz",
    "    Sweep start frequency in MHz. Defaults to a small range around the current band.",
    "  stopMHz",
    "    Sweep stop frequency in MHz. Defaults to a small range around the current band.",
    "  stepKHz",
    "    Frequency step size in kHz. Default 50.",
    "  dwellMs",
    "    Time to wait after each retune before sampling RSSI. Default 20 ms.",
    "  samples",
    "    Number of RSSI reads averaged at each point. Default 3.",
    "",
    "DESCRIPTION",
    "  Tunes the radio across the requested range, measures RSSI at each step,",
    "  and prints a terminal spectrum view using the current band/modulation preset.",
    "  `spectrum live` repeats that sweep continuously and redraws the terminal",
    "  using a fixed dBm-scale block graph for terminal compatibility.",
    "  Live mode defaults to stepKHz=100, dwellMs=2, and samples=1 for faster refresh,",
    "  updates on each measured point, and keeps a short max-hold trace for brief bursts.",
    "  This is a received-power sweep, not an IQ or waterfall display.",
    "",
    "EXAMPLES",
    "  spectrum",
    "  spectrum live",
    "  spectrum 433.7 434.2 25 25 5",
    "  spectrum 868.0 869.0 100 15 2",
  ].join("\n"),
  mode: [
    "NAME",
    "  mode - show or update the shell radio mode configuration",
    "",
    "USAGE",
    "  mode",
    "  mode [packet|direct_async] [band] [modulation]",
    "",
    "OPTIONS",
    "  packet|direct_async",
    "    Selects the operating workflow.",
    "    `packet` is FIFO RX/TX.",
    "    `direct_async` is GPIO-based OOK listen/record/replay.",
    "  band",
    "    RF band preset. Supported values: 315, 433, 868, 915.",
    "  modulation",
    "    Radio modulation. Supported values: ook, fsk, 2fsk, gfsk, msk.",
    "    `fsk` remains a legacy packet preset alias.",
    "    In practice, direct_async is intended for ook.",
    "",
    "DESCRIPTION",
    "  With no arguments, prints the current in-memory shell configuration.",
    "  With arguments, updates the shell defaults used by listen/send/replay.",
  ].join("\n"),
  listen: [
    "NAME",
    "  listen - receive traffic using the current shell mode",
    "",
    "USAGE",
    "  listen [pollMs]",
    "  listen [silenceGapUs] [sampleRateUs]",
    "",
    "MODE BEHAVIOR",
    "  packet mode",
    "    listen [pollMs]",
    "    Starts FIFO packet receive polling.",
    "  direct_async mode",
    "    listen [silenceGapUs] [sampleRateUs]",
    "    Starts a raw OOK edge listener with two states:",
    "    silence -> signal_detected -> silence.",
    "    The edges collected between those state transitions are emitted as one raw signal window.",
    "",
    "OPTIONS",
    "  pollMs",
    "    Packet mode only. Delay between FIFO polling passes. Default 20 ms.",
    "  silenceGapUs",
    "    Direct-async mode only. If no new edge arrives for at least this many microseconds,",
    "    the current signal is considered finished and the listener returns to silence.",
    `    Default ${appConfig.directAsync.rx.silenceGapUs} us.`,
    "  sampleRateUs",
    "    Direct-async mode only. Preferred bit unit size for the live `bits` row.",
    "    This affects rendering only and does not filter live edges.",
    "",
    "DESCRIPTION",
    `  Direct-async RX pin routing is taken from config.js (default Pi GPIO ${appConfig.directAsync.rx.gpio}).`,
    "  Every silence-delimited signal is emitted, including single-edge signals.",
    "  Stops any existing runtime before starting a new listener.",
    "  Stop it with `stop`, `idle`, `disconnect`, or Ctrl+C.",
  ].join("\n"),
  send: [
    "NAME",
    "  send - transmit packet bytes or replay a saved direct-async frame",
    "",
    "USAGE",
    "  send <hex-bytes...>",
    "  send <file> [frameIndex] [silenceGapUs] [sampleRateUs] [repeats] [invert]",
    "",
    "MODE BEHAVIOR",
    "  packet mode",
    "    Expects one or more hex byte tokens such as `aa 55 01` or `0xaa 0x55 0x01`.",
    "  direct_async mode",
    "    Expects a saved replayable file and forwards to the replay path.",
    "",
    "OPTIONS",
    "  file",
    "    Path to a saved raw stream or raw replay JSON file.",
    "  frameIndex",
    "    For raw stream files, replay this identified frame. Default 0.",
    "  silenceGapUs",
    `    For raw stream files, split frames using this silence threshold. Default ${appConfig.directAsync.rx.silenceGapUs} us.`,
    "  sampleRateUs",
    "    Optional extracted-frame sample rate / bit duration in microseconds.",
    `    Edges shorter than this are filtered out post-processing, and the bit view uses this as its unit.`,
    "  repeats",
    `    Number of transmissions. Default ${appConfig.directAsync.tx.repeats}.`,
    "  invert",
    "    Invert replay polarity. Accepts true/false, 1/0, yes/no, invert/normal.",
    `    Default ${appConfig.directAsync.tx.invert}.`,
    "",
    "DESCRIPTION",
    "  Use `send` instead of separate TX verbs. In packet mode it writes FIFO data.",
    "  In direct_async mode it replays the saved raw edge timing file after applying",
    `  the TX pin routing from config.js (default Pi GPIO ${appConfig.directAsync.tx.gpio}) and`,
    `  the built-in minimum pulse width filter (${DEFAULT_MINIMUM_PULSE_WIDTH_US} us).`,
  ].join("\n"),
  record: [
    "NAME",
    "  record - capture one continuous direct-async edge stream to a file",
    "",
    "USAGE",
    "  record <file>",
    "",
    "OPTIONS",
    "  file",
    "    Output JSON file that receives the full recorded edge stream.",
    "",
    "DESCRIPTION",
    "  Stores the raw edge stream exactly as seen on the GPIO line.",
    `  RX pin routing is taken from config.js (default Pi GPIO ${appConfig.directAsync.rx.gpio}).`,
    "  Every observed edge is recorded. No duration threshold is applied.",
    "  No normalization, snapping, trimming, decoding, or frame extraction is performed.",
    "  While recording, the shell renders a continuously updating sampled live preview over the",
    "  recent time window and shows the most recent raw edge values.",
    "  Finish with `stop`.",
  ].join("\n"),
  replay: [
    "NAME",
    "  replay - transmit a saved raw edge file through direct async TX",
    "",
    "USAGE",
    "  replay <file> [frameIndex] [silenceGapUs] [sampleRateUs] [repeats] [invert]",
    "",
    "OPTIONS",
    "  file",
    "    Saved raw stream or replayable raw edge JSON file.",
    "  frameIndex",
    "    For raw stream files, replay this identified frame. Default 0.",
    "  silenceGapUs",
    `    For raw stream files, split frames using this silence threshold. Default ${appConfig.directAsync.rx.silenceGapUs} us.`,
    "  sampleRateUs",
    "    Optional extracted-frame sample rate / bit duration in microseconds.",
    `    Edges shorter than this are filtered out post-processing before replay.`,
    "  repeats",
    `    Number of times to transmit the sequence. Default ${appConfig.directAsync.tx.repeats}.`,
    "  invert",
    "    Invert replay polarity. Accepts true/false, 1/0, yes/no, invert/normal.",
    `    Default ${appConfig.directAsync.tx.invert}.`,
    "",
    "DESCRIPTION",
    "  Stops active work, puts the radio into direct async TX, segments the file into frames",
    "  using the supplied silence threshold, and replays the selected frame as recorded edge events",
    "  rebased to the start of that frame.",
    `  TX pin routing is taken from config.js (default Pi GPIO ${appConfig.directAsync.tx.gpio}).`,
    `  A built-in minimum pulse width filter (${DEFAULT_MINIMUM_PULSE_WIDTH_US} us) is applied`,
    "  to the extracted frame before replay.",
  ].join("\n"),
  show: [
    "NAME",
    "  show - summarize a saved JSON file",
    "",
    "USAGE",
    "  show <file> [silenceGapUs] [sampleRateUs]",
    "",
    "OPTIONS",
    "  file",
    "    Any saved stream/frame/capture JSON file.",
    "  silenceGapUs",
    `    For raw stream files, split frames using this silence threshold. Default ${appConfig.directAsync.rx.silenceGapUs} us.`,
    "  sampleRateUs",
    "    Optional extracted-frame sample rate / bit duration in microseconds.",
    `    Edges shorter than this are filtered out post-processing, and the bit view uses this as its unit.`,
    "",
    "DESCRIPTION",
    "  Prints a short summary including timestamp, edge count, and top-level fields.",
    "  For raw edge files, it also segments the stream into silence-delimited frames and renders",
    "  each frame with a compact shape row and a scaled high/low timeline so similar captures",
    "  can be compared visually without changing the stored timings.",
    "  Every identified frame is shown, including single-edge frames.",
    `  The default segmentation/filter values come from config.js.`,
    `  A built-in minimum pulse width filter (${DEFAULT_MINIMUM_PULSE_WIDTH_US} us) is applied`,
    "  to extracted frames before rendering.",
  ].join("\n"),
  stop: [
    "NAME",
    "  stop - stop the active listener or runtime",
    "",
    "USAGE",
    "  stop",
    "",
    "DESCRIPTION",
    "  Stops packet listen loops and direct-async runtimes such as listen or record.",
    "  Does not disconnect the SPI device.",
  ].join("\n"),
  idle: [
    "NAME",
    "  idle - stop active work and send the radio to IDLE",
    "",
    "USAGE",
    "  idle",
    "",
    "DESCRIPTION",
    "  Equivalent to stopping the active runtime and then issuing SIDLE to the radio.",
  ].join("\n"),
  clear: [
    "NAME",
    "  clear - clear the terminal",
    "",
    "USAGE",
    "  clear",
  ].join("\n"),
  quit: [
    "NAME",
    "  quit - exit the shell cleanly",
    "",
    "USAGE",
    "  quit",
    "  exit",
    "",
    "DESCRIPTION",
    "  Stops active work, disconnects from the radio, and exits the process.",
  ].join("\n"),
};

function createDefaultRadioConfig() {
  return {
    band: appConfig.radio.band,
    modulation: appConfig.radio.modulation,
    mode: appConfig.radio.mode,
    packet: {
      appendStatus: true,
      lengthMode: PACKET_LENGTH_MODE.VARIABLE,
    },
    gpio: {},
  };
}

function decodeRssi(raw) {
  let value = raw;
  if (value >= 128) value -= 256;
  return (value / 2) - 74;
}

function getDefaultSpectrumRange(band) {
  const ranges = {
    [BAND.MHZ_315]: { startMHz: 314, stopMHz: 316 },
    [BAND.MHZ_433]: { startMHz: 433.0, stopMHz: 435.0 },
    [BAND.MHZ_868]: { startMHz: 867.0, stopMHz: 869.0 },
    [BAND.MHZ_915]: { startMHz: 914.0, stopMHz: 916.0 },
  };

  return ranges[band] ?? ranges[BAND.MHZ_433];
}

function formatMHz(value, stepKHz = 50) {
  const decimals = stepKHz < 100 ? 3 : stepKHz < 1000 ? 2 : 1;
  return Number(value).toFixed(decimals);
}

const SPECTRUM_DBM_MIN = -110;
const SPECTRUM_DBM_MAX = -40;
const SPECTRUM_DBM_STEP = 10;

function renderSpectrum(points, stepKHz) {
  if (!points.length) return "no spectrum samples";

  const values = points.map((point) => point.rssiDbm);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1);
  const width = 48;

  const lines = points.map((point) => {
    const normalized = (point.rssiDbm - min) / span;
    const barLength = Math.max(1, Math.round(normalized * width));
    const bar = "#".repeat(barLength);
    return `${formatMHz(point.freqMHz, stepKHz).padStart(8, " ")} MHz | ${bar.padEnd(width, " ")} ${point.rssiDbm.toFixed(1).padStart(6, " ")} dBm`;
  });

  const peaks = [...points]
    .sort((left, right) => right.rssiDbm - left.rssiDbm)
    .slice(0, Math.min(3, points.length))
    .map((point, index) => `${index + 1}. ${formatMHz(point.freqMHz, stepKHz)} MHz ${point.rssiDbm.toFixed(1)} dBm`);

  return [
    `range ${formatMHz(points[0].freqMHz, stepKHz)}-${formatMHz(points[points.length - 1].freqMHz, stepKHz)} MHz  samples=${points.length}`,
    `floor ${min.toFixed(1)} dBm  peak ${max.toFixed(1)} dBm`,
    "",
    ...lines,
    "",
    "strongest peaks:",
    ...peaks,
  ].join("\n");
}

function sampleSpectrumPoints(points, targetCount) {
  if (!points.length || targetCount <= 0) {
    return [];
  }

  const sampled = [];
  if (points.length === 1) {
    for (let index = 0; index < targetCount; index += 1) {
      sampled.push(points[0].rssiDbm);
    }
    return sampled;
  }

  for (let index = 0; index < targetCount; index += 1) {
    const sourceIndex = Math.round(index * (points.length - 1) / Math.max(targetCount - 1, 1));
    sampled.push(points[sourceIndex].rssiDbm);
  }
  return sampled;
}

function clampDbm(value) {
  return Math.max(SPECTRUM_DBM_MIN, Math.min(SPECTRUM_DBM_MAX, value));
}

function buildSpectrumColumns(values, width, fillChar = "█") {
  const sampled = sampleSpectrumPoints(values.map((value) => ({ rssiDbm: clampDbm(value) })), width);
  const rows = [];

  for (let threshold = SPECTRUM_DBM_MAX; threshold >= SPECTRUM_DBM_MIN; threshold -= SPECTRUM_DBM_STEP) {
    const line = sampled.map((value) => (value >= threshold ? fillChar : " "));
    rows.push(`${String(threshold).padStart(4, " ")} ${line.join("")}`);
  }

  return rows;
}

function renderBlockSpectrumPreview(points, stepKHz, sweepCount, pointIndex, totalPoints, holdValues = []) {
  const presentPoints = points.filter((point) => point && Number.isFinite(point.rssiDbm));
  if (!presentPoints.length) return "no spectrum samples";

  const values = presentPoints.map((point) => point.rssiDbm);
  const peak = Math.max(...values);
  const floor = Math.min(...values);

  const liveValues = points.map((point) => (
    point && Number.isFinite(point.rssiDbm) ? point.rssiDbm : SPECTRUM_DBM_MIN
  ));
  const liveRows = buildSpectrumColumns(liveValues, 64, "█");
  const holdRows = holdValues.length ? buildSpectrumColumns(holdValues, 64, "·") : [];

  const strongest = [...presentPoints]
    .sort((left, right) => right.rssiDbm - left.rssiDbm)
    .slice(0, Math.min(3, presentPoints.length))
    .map((point, index) => `${index + 1}. ${formatMHz(point.freqMHz, stepKHz)} MHz ${point.rssiDbm.toFixed(1)} dBm`);

  return [
    `${COLOR.cyan}spectrum${COLOR.reset} ${COLOR.dim}| live preview${COLOR.reset}  sweeps=${sweepCount}  point=${pointIndex}/${totalPoints}`,
    `${COLOR.blue}range${COLOR.reset}=${formatMHz(points[0].freqMHz, stepKHz)}-${formatMHz(points[points.length - 1].freqMHz, stepKHz)} MHz  ` +
      `${COLOR.blue}scale${COLOR.reset}=${SPECTRUM_DBM_MIN}..${SPECTRUM_DBM_MAX} dBm  ` +
      `${COLOR.blue}floor${COLOR.reset}=${floor.toFixed(1)} dBm  ${COLOR.blue}peak${COLOR.reset}=${peak.toFixed(1)} dBm`,
    `${COLOR.dim}solid blocks=live  dots=short max-hold  Ctrl+C or 'stop' ends live spectrum mode${COLOR.reset}`,
    "",
    ...liveRows,
    ...(holdRows.length ? holdRows.map((line) => `${COLOR.dim}${line}${COLOR.reset}`) : []),
    `     ${formatMHz(points[0].freqMHz, stepKHz)} MHz${" ".repeat(40)}${formatMHz(points[points.length - 1].freqMHz, stepKHz)} MHz`,
    "",
    "strongest peaks:",
    ...strongest,
  ].join("\n");
}

function normalizeSpectrumArgs(startMHz, stopMHz, stepKHz, dwellMs, samples, band) {
  const defaults = getDefaultSpectrumRange(band);
  const start = Number(startMHz ?? defaults.startMHz);
  const stop = Number(stopMHz ?? defaults.stopMHz);
  const step = Number(stepKHz ?? 50);
  const dwell = Number(dwellMs ?? 20);
  const sampleCount = Number(samples ?? 3);

  if (!Number.isFinite(start) || !Number.isFinite(stop)) {
    throw new Error("spectrum frequencies must be valid MHz numbers");
  }
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error("spectrum stepKHz must be greater than 0");
  }
  if (!Number.isFinite(dwell) || dwell < 0) {
    throw new Error("spectrum dwellMs must be 0 or greater");
  }
  if (!Number.isInteger(sampleCount) || sampleCount < 1) {
    throw new Error("spectrum samples must be an integer greater than 0");
  }
  if (stop < start) {
    throw new Error("spectrum stopMHz must be greater than or equal to startMHz");
  }

  return {
    startMHz: start,
    stopMHz: stop,
    stepKHz: step,
    dwellMs: dwell,
    samples: sampleCount,
    stepMHz: step / 1000,
  };
}

function normalizeLiveSpectrumArgs(startMHz, stopMHz, stepKHz, dwellMs, samples, band) {
  return normalizeSpectrumArgs(
    startMHz,
    stopMHz,
    stepKHz ?? 100,
    dwellMs ?? 2,
    samples ?? 1,
    band
  );
}

function parseLine(line) {
  const tokens = [];
  const matches = line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];

  for (const match of matches) {
    if (
      (match.startsWith("\"") && match.endsWith("\"")) ||
      (match.startsWith("'") && match.endsWith("'"))
    ) {
      tokens.push(match.slice(1, -1));
    } else {
      tokens.push(match);
    }
  }

  return tokens;
}

function parseBand(value, fallback) {
  if (!value) return fallback;
  if (Object.values(BAND).includes(value)) return value;
  throw new Error(`Invalid band: ${value}`);
}

function parseModulation(value, fallback) {
  if (!value) return fallback;
  const normalized = value.toLowerCase();
  if (Object.values(MODULATION).includes(normalized)) return normalized;
  throw new Error(`Invalid modulation: ${value}`);
}

function parseMode(value, fallback) {
  if (!value) return fallback;
  if (Object.values(RADIO_MODE).includes(value)) return value;
  throw new Error(`Invalid mode: ${value}`);
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;

  const normalized = String(value).toLowerCase();
  if (["1", "true", "yes", "on", "invert", "inverted"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "normal"].includes(normalized)) return false;

  throw new Error(`Invalid boolean flag: ${value}`);
}

async function stableRead(radio, address) {
  let previous = await radio.readRegister(address);
  for (let i = 0; i < 3; i += 1) {
    const current = await radio.readRegister(address);
    if (current === previous) return current;
    previous = current;
  }
  return previous;
}

class RadioShell {
  constructor(options = {}) {
    this.bus = options.bus ?? appConfig.spi.bus;
    this.device = options.device ?? appConfig.spi.device;
    this.speedHz = options.speedHz ?? appConfig.spi.speedHz;
    this.radio = null;
    this.listening = false;
    this.runtime = null;
    this.radioConfig = createDefaultRadioConfig();
  }

  async ensureConnected() {
    if (this.radio) return;
    await this.connect(this.bus, this.device, this.speedHz);
  }

  async connect(bus = this.bus, device = this.device, speedHz = this.speedHz) {
    if (this.radio) {
      await this.disconnect();
    }

    this.bus = Number(bus);
    this.device = Number(device);
    this.speedHz = Number(speedHz);
    this.radio = new CC1101Driver({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
    });

    await this.radio.open();
    await this.radio.reset();
    const info = await this.radio.verifyChip();
    console.log(
      `connected bus=${this.bus} device=${this.device} speed=${this.speedHz} part=0x${info.partnum
        .toString(16)
        .padStart(2, "0")} version=0x${info.version.toString(16).padStart(2, "0")}`
    );
  }

  async disconnect() {
    await this.stop();

    if (!this.radio) return;

    try {
      await this.radio.idle();
    } catch {}

    await this.radio.close().catch(() => {});
    this.radio = null;
  }

  printHelp() {
    console.log("commands:");
    console.log("  help");
    console.log("  man [command]");
    console.log("  connect [bus] [device] [speedHz]");
    console.log("  disconnect");
    console.log("  status");
    console.log("  spectrum [startMHz] [stopMHz] [stepKHz] [dwellMs] [samples]");
    console.log("  spectrum live [startMHz] [stopMHz] [stepKHz] [dwellMs] [samples]");
    console.log("  mode [packet|direct_async] [band] [modulation]");
    console.log("  listen [pollMs]");
    console.log("  listen [silenceGapUs] [sampleRateUs]");
    console.log("  send <hex-bytes...>");
    console.log("  send <file> [frameIndex] [silenceGapUs] [sampleRateUs] [repeats] [invert]");
    console.log("  record <file>");
    console.log("  replay <file> [frameIndex] [silenceGapUs] [sampleRateUs] [repeats] [invert]");
    console.log("  show <file> [silenceGapUs] [sampleRateUs]");
    console.log("  stop");
    console.log("  idle");
    console.log("  clear");
    console.log("  quit");
    console.log("");
    console.log("examples:");
    console.log("  man listen");
    console.log("  spectrum");
    console.log("  spectrum live");
    console.log("  mode packet 433 ook");
    console.log("  listen 20");
    console.log("  send aa 55 01");
    console.log("  mode direct_async 433 ook");
    console.log(`  listen ${appConfig.directAsync.rx.silenceGapUs} 250`);
    console.log("  record /tmp/rf-captures/session-001.json");
    console.log("  stop");
    console.log(`  show /tmp/rf-captures/session-001.json ${appConfig.directAsync.rx.silenceGapUs} 250`);
    console.log(`  replay /tmp/rf-captures/session-001.json 0 ${appConfig.directAsync.rx.silenceGapUs} 250 ${appConfig.directAsync.tx.repeats} false`);
  }

  printManual(command) {
    if (!command) {
      console.log("manual entries:");
      console.log(`  ${Object.keys(MANUALS).sort().join(", ")}`);
      console.log("use `man <command>` for details");
      return;
    }

    const key = String(command).toLowerCase();
    const aliases = {
      exit: "quit",
    };
    const resolved = aliases[key] ?? key;
    const manual = MANUALS[resolved];

    if (!manual) {
      console.log(`no manual entry for \`${command}\``);
      return;
    }

    console.log(manual);
  }

  printMode() {
    console.log(JSON.stringify(this.radioConfig, null, 2));
  }

  setMode(mode, band, modulation) {
    this.radioConfig = {
      ...this.radioConfig,
      mode: parseMode(mode, this.radioConfig.mode),
      band: parseBand(band, this.radioConfig.band),
      modulation: parseModulation(modulation, this.radioConfig.modulation),
      packet: mode === RADIO_MODE.PACKET || (!mode && this.radioConfig.mode === RADIO_MODE.PACKET)
        ? {
          appendStatus: true,
          lengthMode: PACKET_LENGTH_MODE.VARIABLE,
        }
        : {
          appendStatus: false,
        },
    };

    console.log("mode updated");
    this.printMode();
  }

  async printStatus() {
    await this.ensureConnected();

    const marc = await stableRead(this.radio, STATUS.MARCSTATE);
    const rssi = await stableRead(this.radio, STATUS.RSSI);
    const pktstatus = await stableRead(this.radio, STATUS.PKTSTATUS);
    const rxbytes = await stableRead(this.radio, STATUS.RXBYTES);
    const txbytes = await stableRead(this.radio, STATUS.TXBYTES);

    console.log(`MARCSTATE: ${MARCSTATE_MAP[marc & 0x1f] ?? "UNKNOWN"} (${marc & 0x1f})`);
    console.log(`RSSI raw : ${rssi}`);
    console.log(`RSSI dBm : ${decodeRssi(rssi).toFixed(1)}`);
    console.log(`PKTSTATUS: 0x${pktstatus.toString(16).padStart(2, "0")}`);
    console.log(`RXBYTES  : ${rxbytes & 0x7f}`);
    console.log(`TXBYTES  : ${txbytes & 0x7f}`);
  }

  async spectrum(startMHz, stopMHz, stepKHz = 50, dwellMs = 20, samples = 3) {
    await this.ensureConnected();
    await this.stop();
    const config = normalizeSpectrumArgs(
      startMHz,
      stopMHz,
      stepKHz,
      dwellMs,
      samples,
      this.radioConfig.band
    );
    const points = await this.collectSpectrumSweep(config);
    await this.radio.idle();
    console.log(renderSpectrum(points, config.stepKHz));
  }

  async prepareSpectrumSweep() {
    await this.radio.configureRadio({
      ...this.radioConfig,
      mode: RADIO_MODE.PACKET,
      packet: {
        appendStatus: false,
        lengthMode: PACKET_LENGTH_MODE.FIXED,
        length: 1,
      },
    });
  }

  async readSpectrumRssi(sampleCount, fastMode = false) {
    let rssiTotal = 0;
    for (let i = 0; i < sampleCount; i += 1) {
      const rssiRaw = fastMode
        ? await this.radio.getRssi()
        : await stableRead(this.radio, STATUS.RSSI);
      rssiTotal += decodeRssi(rssiRaw);
      if (i + 1 < sampleCount) {
        await sleep(fastMode ? 1 : 2);
      }
    }

    return rssiTotal / sampleCount;
  }

  async collectSpectrumSweep(config, options = {}) {
    const fastMode = Boolean(options.fastMode);
    const reconfigure = options.reconfigure !== false;
    /** @type {{ freqMHz: number, rssiDbm: number }[]} */
    const points = [];

    if (reconfigure) {
      await this.prepareSpectrumSweep();
    }

    if (fastMode) {
      await this.radio.enterRxSafe();
    }

    for (
      let freqMHz = config.startMHz;
      freqMHz <= config.stopMHz + (config.stepMHz / 2);
      freqMHz += config.stepMHz
    ) {
      const roundedFreqMHz = Number(freqMHz.toFixed(6));
      await this.radio.setFrequencyMHz(roundedFreqMHz);

      if (fastMode) {
        await this.radio.enterRx();
      } else {
        await this.radio.enterRxSafe();
      }

      if (config.dwellMs > 0) {
        await sleep(config.dwellMs);
      }

      points.push({
        freqMHz: roundedFreqMHz,
        rssiDbm: await this.readSpectrumRssi(config.samples, fastMode),
      });
    }

    return points;
  }

  decaySpectrumHold(holdValues, amountDb = 3) {
    for (let i = 0; i < holdValues.length; i += 1) {
      if (!Number.isFinite(holdValues[i])) continue;
      holdValues[i] -= amountDb;
    }
  }

  async spectrumLive(startMHz, stopMHz, stepKHz = 50, dwellMs = 20, samples = 3) {
    await this.ensureConnected();
    await this.stop();

    const config = normalizeLiveSpectrumArgs(
      startMHz,
      stopMHz,
      stepKHz,
      dwellMs,
      samples,
      this.radioConfig.band
    );

    const runtime = {
      active: true,
      stop: async () => {
        runtime.active = false;
        if (this.radio) {
          await this.radio.idle().catch(() => {});
        }
      },
    };

    this.runtime = runtime;
    let sweepCount = 0;
    await this.prepareSpectrumSweep();
    const totalPoints = Math.floor(((config.stopMHz - config.startMHz) / config.stepMHz) + 1.5);
    /** @type {(null | { freqMHz: number, rssiDbm: number })[]} */
    const previewPoints = [];
    /** @type {number[]} */
    const holdValues = [];
    for (let i = 0; i < totalPoints; i += 1) {
      const freqMHz = Number((config.startMHz + (config.stepMHz * i)).toFixed(6));
      previewPoints.push({ freqMHz, rssiDbm: -120 });
      holdValues.push(-120);
    }

    while (runtime.active) {
      sweepCount += 1;
      this.decaySpectrumHold(holdValues, 4);

      for (let pointIndex = 0; pointIndex < totalPoints; pointIndex += 1) {
        if (!runtime.active) break;

        const freqMHz = Number((config.startMHz + (config.stepMHz * pointIndex)).toFixed(6));
        await this.radio.setFrequencyMHz(freqMHz);
        await this.radio.enterRx();

        if (config.dwellMs > 0) {
          await sleep(config.dwellMs);
        }

        const rssiDbm = await this.readSpectrumRssi(config.samples, true);
        previewPoints[pointIndex] = { freqMHz, rssiDbm };
        holdValues[pointIndex] = Math.max(holdValues[pointIndex], rssiDbm);

        process.stdout.write("\u001b[2J\u001b[H");
        process.stdout.write(`${renderBlockSpectrumPreview(
          previewPoints,
          config.stepKHz,
          sweepCount,
          pointIndex + 1,
          totalPoints,
          holdValues
        )}\n`);
      }
    }
  }

  async startPacketListen(pollMs = 20) {
    await this.ensureConnected();
    await this.stop();
    await this.radio.startPacketRx(this.radioConfig);
    this.listening = true;

    console.log(`packet listen started pollMs=${pollMs}`);

    while (this.listening) {
      const result = await this.radio.readFifoPacket();

      if (result.overflow) {
        console.log("[rx] overflow");
      } else if (result.invalidLength) {
        console.log(`[rx] invalid length=${result.invalidLength}`);
      } else if (result.packet) {
        console.log(
          `[rx] len=${result.packet.length} payload=[${hex(result.packet.payload)}] status=[${hex(result.packet.status)}]`
        );
      }

      await sleep(Number(pollMs));
    }
  }

  async startDirectAsyncListen(silenceGapUs = appConfig.directAsync.rx.silenceGapUs, sampleRateUs = appConfig.directAsync.rx.bitUnitUs) {
    await this.stop();
    await this.disconnect();

    this.runtime = new CC1101RawListener({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
      gpio: appConfig.directAsync.rx.gpio,
      silenceGapUs: Number(silenceGapUs),
      bitUnitUs: sampleRateUs !== undefined ? Number(sampleRateUs) : undefined,
      onMessage: (message) => {
        console.log(`[async] ${message}`);
      },
    });

    await this.runtime.start();
  }

  async listen(arg0, arg1) {
    if (this.radioConfig.mode === RADIO_MODE.PACKET) {
      await this.startPacketListen(Number(arg0 ?? 20));
      return;
    }

    await this.startDirectAsyncListen(
      Number(arg0 ?? appConfig.directAsync.rx.silenceGapUs),
      arg1
    );
  }

  async replay(file, frameIndex = 0, silenceGapUs = appConfig.directAsync.rx.silenceGapUs, sampleRateUs = appConfig.directAsync.filter.minimumPulseWidthUs, repeats = appConfig.directAsync.tx.repeats, invert = appConfig.directAsync.tx.invert) {
    if (!file) {
      throw new Error("replay requires a capture file path");
    }

    await this.stop();
    await this.disconnect();

    const capture = loadCaptureFile(file);
    const replay = buildReplayFromCapture(capture, {
      frameIndex: Number(frameIndex),
      silenceGapUs: Number(silenceGapUs),
      minimumPulseWidthUs: Number(sampleRateUs),
    });

    const replayer = new CC1101WindowReplayer({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
      txDataGpio: appConfig.directAsync.tx.gpio,
      repeats: Number(repeats),
      invert: parseBooleanFlag(invert, false),
      onMessage: (message) => {
        console.log(`[replay] ${message}`);
      },
    });

    await replayer.replay(replay);
  }

  async send(args) {
    await this.ensureConnected();

    if (!args.length) {
      throw new Error("send requires payload bytes in packet mode or a file path in direct_async mode");
    }

    if (this.radioConfig.mode === RADIO_MODE.PACKET) {
      const payload = parsePayload(args.join(" "));
      await this.radio.transmitPacket(payload, this.radioConfig);
      console.log(`tx payload=[${hex(payload)}]`);
      return;
    }

    const [file, frameIndex, silenceGapUs, sampleRateUs, repeats, invert] = args;
    if (!fs.existsSync(String(file))) {
      throw new Error("direct_async send requires a replayable file path");
    }

    await this.replay(
      file,
      frameIndex ?? 0,
      silenceGapUs ?? appConfig.directAsync.rx.silenceGapUs,
      sampleRateUs ?? appConfig.directAsync.filter.minimumPulseWidthUs,
      repeats ?? appConfig.directAsync.tx.repeats,
      invert ?? appConfig.directAsync.tx.invert
    );
  }

  async record(file) {
    if (!file) {
      throw new Error("record requires an output file path");
    }

    await this.stop();
    await this.disconnect();

    const renderLiveRecordFrame = (frame) => {
      const header = [
        `${COLOR.cyan}record${COLOR.reset} ${COLOR.dim}| live preview${COLOR.reset}`,
        `${COLOR.blue}file${COLOR.reset}=${file}  ${COLOR.blue}gpio${COLOR.reset}=${appConfig.directAsync.rx.gpio}`,
        `${COLOR.dim}Ctrl+C or 'stop' ends recording and saves the stream${COLOR.reset}`,
        "",
      ].join("\n");

      process.stdout.write("\u001b[2J\u001b[H");
      process.stdout.write(`${header}${frame}\n`);
    };

    this.runtime = new CC1101StreamRecorder({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
      filepath: String(file),
      rxDataGpio: appConfig.directAsync.rx.gpio,
      onMessage: (message) => {
        console.log(`[record] ${message}`);
      },
      onPreview: (frame) => {
        renderLiveRecordFrame(frame);
      },
    });

    await this.runtime.start();
  }

  show(file, silenceGapUs = appConfig.directAsync.rx.silenceGapUs, sampleRateUs = appConfig.directAsync.filter.minimumPulseWidthUs) {
    if (!file) {
      throw new Error("show requires a capture file path");
    }

    const capture = loadCaptureFile(file);
    console.log(JSON.stringify({
      file,
      ...summarizeCaptureFile(capture),
    }, null, 2));

    const segmented = renderSegmentedFrames(capture, {
      silenceGapUs: Number(silenceGapUs),
      minimumPulseWidthUs: Number(sampleRateUs),
      bitUnitUs: Number(sampleRateUs),
    });
    if (segmented) {
      console.log("");
      console.log(segmented);
      return;
    }

    const rendered = renderRawSignal(capture, {
      minimumPulseWidthUs: 0,
    });
    if (rendered) {
      console.log("");
      console.log(rendered);
    }
  }

  async stop() {
    if (this.listening) {
      this.listening = false;
      await sleep(5);
      if (this.radio) {
        await this.radio.idle().catch(() => {});
      }
    }

    if (this.runtime) {
      const runtime = this.runtime;
      this.runtime = null;
      await runtime.stop();
      console.log("runtime stopped");
    }
  }

  async idle() {
    await this.ensureConnected();
    await this.stop();
    await this.radio.idle();
    console.log("radio idle");
  }
}

async function executeCommand(shell, line, onExit) {
  const tokens = parseLine(line.trim());
  if (!tokens.length) return;

  const [command, subcommand, ...rest] = tokens;

  if (command === "help") {
    shell.printHelp();
  } else if (command === "man") {
    shell.printManual(subcommand);
  } else if (command === "connect") {
    await shell.connect(subcommand, rest[0], rest[1]);
  } else if (command === "disconnect") {
    await shell.disconnect();
    console.log("disconnected");
  } else if (command === "status") {
    await shell.printStatus();
  } else if (command === "spectrum") {
    if (subcommand === "live") {
      await shell.spectrumLive(rest[0], rest[1], rest[2], rest[3], rest[4]);
    } else {
      await shell.spectrum(subcommand, rest[0], rest[1], rest[2], rest[3]);
    }
  } else if (command === "mode") {
    if (!subcommand) {
      shell.printMode();
    } else {
      shell.setMode(subcommand, rest[0], rest[1]);
    }
  } else if (command === "listen") {
    void shell.listen(subcommand, rest[0]).catch((error) => {
      console.error(`listen failed: ${error.message}`);
    });
  } else if (command === "send") {
    await shell.send([subcommand, ...rest].filter(Boolean));
  } else if (command === "record") {
    await shell.record(subcommand);
  } else if (command === "replay") {
    await shell.replay(subcommand, rest[0], rest[1], rest[2], rest[3], rest[4], rest[5]);
  } else if (command === "show") {
    shell.show(subcommand, rest[0], rest[1]);
  } else if (command === "stop") {
    await shell.stop();
    console.log("stopped");
  } else if (command === "idle") {
    await shell.idle();
  } else if (command === "clear") {
    clearTerminal();
  } else if (command === "quit" || command === "exit") {
    onExit();
  } else {
    console.log("unknown command; type `help` or `man`");
  }
}

function createStatusText(shell) {
  const config = shell.radioConfig;
  const runtime = shell.listening ? "listen" : shell.runtime ? "runtime" : "idle";
  const transport = shell.radio ? "connected" : "disconnected";

  return [
    `link=${transport}`,
    `bus=${shell.bus}`,
    `device=${shell.device}`,
    `speed=${shell.speedHz}`,
    `mode=${config.mode}`,
    `band=${config.band}`,
    `mod=${config.modulation}`,
    `state=${runtime}`,
  ].join("  ");
}

function colorizeStatus(shell) {
  const config = shell.radioConfig;
  const transport = shell.radio ? `${COLOR.green}connected${COLOR.reset}` : `${COLOR.yellow}disconnected${COLOR.reset}`;
  const runtime = shell.listening
    ? `${COLOR.magenta}listen${COLOR.reset}`
    : shell.runtime
      ? `${COLOR.magenta}runtime${COLOR.reset}`
      : `${COLOR.dim}idle${COLOR.reset}`;

  return [
    `${COLOR.cyan}CC1101${COLOR.reset} ${COLOR.dim}| Ctrl+C interrupts | exit closes shell${COLOR.reset}`,
    `${COLOR.blue}link${COLOR.reset}=${transport}  ` +
      `${COLOR.blue}bus${COLOR.reset}=${shell.bus}  ` +
      `${COLOR.blue}dev${COLOR.reset}=${shell.device}  ` +
      `${COLOR.blue}speed${COLOR.reset}=${shell.speedHz}  ` +
      `${COLOR.blue}mode${COLOR.reset}=${config.mode}  ` +
      `${COLOR.blue}band${COLOR.reset}=${config.band}  ` +
      `${COLOR.blue}mod${COLOR.reset}=${config.modulation}  ` +
      `${COLOR.blue}state${COLOR.reset}=${runtime}`,
  ].join("\n");
}

function buildPrompt(shell) {
  return `${colorizeStatus(shell)}\n${COLOR.cyan}cc1101>${COLOR.reset} `;
}

function clearTerminal() {
  process.stdout.write("\u001bc");
}

async function main() {
  const args = parseArgs(process.argv);
  const bus = Number(args.bus ?? appConfig.spi.bus);
  const device = Number(args.device ?? appConfig.spi.device);
  const speedHz = Number(args.speed ?? appConfig.spi.speedHz);
  const shell = new RadioShell({ bus, device, speedHz });
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 200,
  });

  let shuttingDown = false;
  let interrupting = false;

  const prompt = () => {
    if (shuttingDown) return;
    rl.setPrompt(buildPrompt(shell));
    rl.prompt();
  };

  const closeShell = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shell.disconnect().catch(() => {});
    process.exit(0);
  };

  const handleInterrupt = async () => {
    if (interrupting || shuttingDown) return;
    interrupting = true;

    try {
      const hadActiveRuntime = shell.listening || Boolean(shell.runtime);
      await shell.stop();

      if (!hadActiveRuntime) {
        console.log("interrupt ignored; no active runtime");
      }
    } finally {
      interrupting = false;
      prompt();
    }
  };

  process.on("SIGINT", () => {
    void handleInterrupt();
  });

  process.on("SIGTERM", () => {
    void closeShell();
  });

  rl.on("line", async (value) => {
    const line = value.trim();
    try {
      await executeCommand(shell, line, () => void closeShell());
    } catch (error) {
      console.error(error.message);
    } finally {
      prompt();
    }
  });

  rl.on("SIGINT", () => {
    void handleInterrupt();
  });

  rl.on("close", () => {
    if (!shuttingDown) {
      void closeShell();
    }
  });

  try {
    await shell.connect();
    console.log("interactive shell ready");
  } catch (error) {
    console.error(`startup failed: ${error.message}`);
  }

  prompt();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
