#!/usr/bin/env node

const readline = require("readline");
const { CC1101ProtocolDetector } = require("./cc1101/analysis/protocol-detector");
const { CC1101ProtocolListener } = require("./cc1101/analysis/protocol-listener");
const { CC1101RawListener } = require("./cc1101/analysis/raw-listener");
const { CC1101FrameExtractor } = require("./cc1101/analysis/frame-extractor");
const { CC1101WindowCapture } = require("./cc1101/analysis/window-capture");
const { CC1101SignalDetector } = require("./cc1101/analysis/signal-detector");
const { CC1101SegmentCollector } = require("./cc1101/analysis/segment-collector");
const { CC1101WindowConsensus } = require("./cc1101/analysis/window-consensus");
const { CC1101LiveVisualizer } = require("./cc1101/analysis/live-visualizer");
const { CC1101BurstMatcher } = require("./cc1101/analysis/burst-matcher");
const { CC1101CanonicalFrameBuilder } = require("./cc1101/analysis/canonical-frame");
const { CC1101FixedTimingDetector } = require("./cc1101/analysis/fixed-timing-detector");
const { CC1101FrameStabilizer } = require("./cc1101/analysis/frame-stabilizer");
const { CC1101ManualSlicer } = require("./cc1101/analysis/manual-slicer");
const {
  loadCaptureFile: loadSavedCaptureFile,
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
  GDO_SIGNAL,
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

function createDefaultRadioConfig() {
  return {
    band: BAND.MHZ_433,
    modulation: MODULATION.OOK,
    mode: RADIO_MODE.PACKET,
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

function parseGdoSignal(value, fallback) {
  if (!value) return fallback;
  if (Object.values(GDO_SIGNAL).includes(value)) return value;
  throw new Error(`Invalid GDO signal: ${value}`);
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
    this.bus = options.bus ?? 0;
    this.device = options.device ?? 0;
    this.speedHz = options.speedHz ?? 100000;
    this.radio = null;
    this.listening = false;
    this.protocolRuntime = null;
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
    await this.stopListening();
    await this.stopProtocolRuntime();

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
    console.log("  connect [bus] [device] [speedHz]");
    console.log("  disconnect");
    console.log("  reset");
    console.log("  info");
    console.log("  status");
    console.log("  config show");
    console.log("  config set <packet|direct_async> [band] [modulation]");
    console.log("  gpio set [gdo0] [gdo2] [gdo1]");
    console.log("  listen start [pollMs]");
    console.log("  listen stop");
    console.log("  live view [gdo0] [gdo2] [threshold] [windowMs]");
    console.log("  raw listen [gpio] [threshold] [captureMs]");
    console.log("  signal detect [gdo0] [threshold] [lookbackMs] [settleMs]");
    console.log("  timing fixed [gdo0] [threshold] [baseUs] [lookbackMs]");
    console.log("  segment collect [gdo0] [threshold] [baseUs] [lookbackMs]");
    console.log("  burst match [gpio] [silenceGapUs] [minEdges] [baseUnitUs]");
    console.log("  canonical build [gpio] [silenceGapUs] [minEdges] [baseUnitUs]");
    console.log("  stabilize frame [gdo0] [threshold] [baseUs] [lookbackMs]");
    console.log("  consensus start [gdo0] [threshold] [baseUs] [beforeMs] [afterMs]");
    console.log("  slice inspect [gdo0] [threshold] [baseUs] [beforeMs] [afterMs]");
    console.log("  frame extract [gdo0] [gdo2] [threshold] [silenceGapUs] [minEdges]");
    console.log("  capture save [rxDataGpio] [threshold] [baseUs] [beforeMs] [afterMs] [outDir]");
    console.log("  capture show <file>");
    console.log("  capture replay <file> [txDataGpio] [mode] [repeats] [baseUs]");
    console.log("  window capture [rxDataGpio] [threshold] [baseUs] [beforeMs] [afterMs] [outDir]");
    console.log("  window replay <file> [txDataGpio] [mode] [repeats] [baseUs]");
    console.log("  protocol detect [gdo0] [threshold] [baseUs]");
    console.log("  protocol listen [name] [gdo0] [threshold] [baseUs] [tolerance]");
    console.log("  protocol stop");
    console.log("  rssi [count] [intervalMs]");
    console.log("  tx <hex-bytes...>");
    console.log("  idle");
    console.log("  quit");
    console.log("");
    console.log("example:");
    console.log("  config set packet 433 ook");
    console.log("  listen start 20");
    console.log("  tx aa 55 01");
    console.log("  config set direct_async 433 ook");
    console.log("  gpio set async_serial_data high_impedance high_impedance");
    console.log("  live view 24 25 100 3000");
    console.log("  raw listen 24 100 220");
    console.log("  signal detect 24 100 1000 220");
    console.log("  timing fixed 24 100 500 1000");
    console.log("  segment collect 24 100 400 500");
    console.log("  burst match 24 10000 16 0");
    console.log("  canonical build 24 10000 16 0");
    console.log("  stabilize frame 24 100 500 1000");
    console.log("  consensus start 24 100 400 1000 1000");
    console.log("  slice inspect 24 100 400 1000 1000");
    console.log("  frame extract 24 25 100 8000 12");
    console.log("  capture save 24 100 400 1000 1000 /tmp/rf-captures");
    console.log("  capture show /tmp/rf-captures/capture-001.json");
    console.log("  capture replay /tmp/rf-captures/capture-001.json 24 normalized 10 400");
    console.log("  window capture 24 100 400 1000 1000 /tmp/rf-captures");
    console.log("  window replay /tmp/rf-captures/capture-001.json 24 normalized 10 400");
    console.log("  protocol detect 24 100 375");
    console.log("  protocol listen ev1527_like 24 100 375 1");
  }

  printConfig() {
    console.log(JSON.stringify(this.radioConfig, null, 2));
  }

  async reset() {
    await this.ensureConnected();
    await this.stopListening();
    await this.stopProtocolRuntime();
    await this.radio.reset();
    console.log("radio reset");
  }

  async printInfo() {
    await this.ensureConnected();
    const info = await this.radio.getChipInfo();
    console.log(JSON.stringify(info, null, 2));
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

  setConfig(mode, band, modulation) {
    this.radioConfig = {
      ...this.radioConfig,
      mode: parseMode(mode, this.radioConfig.mode),
      band: parseBand(band, this.radioConfig.band),
      modulation: parseModulation(modulation, this.radioConfig.modulation),
    };

    if (this.radioConfig.mode === RADIO_MODE.PACKET) {
      this.radioConfig.packet = {
        appendStatus: true,
        lengthMode: PACKET_LENGTH_MODE.VARIABLE,
        ...this.radioConfig.packet,
      };
    } else {
      this.radioConfig.packet = {
        appendStatus: false,
      };
    }

    console.log("config updated");
    this.printConfig();
  }

  setGpio(gdo0, gdo2, gdo1) {
    this.radioConfig.gpio = {
      ...this.radioConfig.gpio,
      gdo0: parseGdoSignal(
        gdo0,
        this.radioConfig.gpio.gdo0 ?? GDO_SIGNAL.ASYNC_SERIAL_DATA
      ),
      gdo2: parseGdoSignal(
        gdo2,
        this.radioConfig.gpio.gdo2 ?? GDO_SIGNAL.PQI
      ),
      gdo1: parseGdoSignal(
        gdo1,
        this.radioConfig.gpio.gdo1 ?? GDO_SIGNAL.HIGH_IMPEDANCE
      ),
    };

    console.log("gpio routing updated");
    this.printConfig();
  }

  async startListening(pollMs = 20) {
    await this.ensureConnected();
    await this.stopListening();
    await this.stopProtocolRuntime();

    if (this.radioConfig.mode !== RADIO_MODE.PACKET) {
      throw new Error("listen start currently supports packet mode only");
    }

    await this.radio.startPacketRx(this.radioConfig);
    this.listening = true;

    console.log(`listening for packets pollMs=${pollMs}`);

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

  async stopListening() {
    if (!this.listening) return;
    this.listening = false;
    await sleep(5);
    if (this.radio) {
      await this.radio.idle().catch(() => {});
    }
    console.log("listening stopped");
  }

  async startProtocolDetection(gdo0 = 24, threshold = 100, baseUs = 375) {
    await this.stopListening();
    await this.stopProtocolRuntime();
    await this.disconnect();

    this.protocolRuntime = new CC1101ProtocolDetector({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
      gdo0: Number(gdo0),
      threshold: Number(threshold),
      baseUs: Number(baseUs),
      onMessage: (message) => {
        console.log(`[protocol] ${message}`);
      },
    });

    await this.protocolRuntime.start();
  }

  async startProtocolListen(
    protocol = "ev1527_like",
    gdo0 = 24,
    threshold = 100,
    baseUs = 375,
    tolerance = 1
  ) {
    await this.stopListening();
    await this.stopProtocolRuntime();
    await this.disconnect();

    this.protocolRuntime = new CC1101ProtocolListener({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
      protocol,
      gdo0: Number(gdo0),
      threshold: Number(threshold),
      baseUs: Number(baseUs),
      tolerance: Number(tolerance),
      onMessage: (message) => {
        console.log(`[protocol] ${message}`);
      },
    });

    await this.protocolRuntime.start();
  }

  async startRawListen(gpio = 24, threshold = 100, captureMs = 220) {
    await this.stopListening();
    await this.stopProtocolRuntime();
    await this.disconnect();

    this.protocolRuntime = new CC1101RawListener({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
      gpio: Number(gpio),
      threshold: Number(threshold),
      captureMs: Number(captureMs),
      onMessage: (message) => {
        console.log(`[raw] ${message}`);
      },
    });

    await this.protocolRuntime.start();
  }

  async startLiveView(gdo0 = 24, gdo2 = 25, threshold = 100, windowMs = 3000) {
    await this.stopListening();
    await this.stopProtocolRuntime();
    await this.disconnect();

    this.protocolRuntime = new CC1101LiveVisualizer({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
      gdo0: Number(gdo0),
      gdo2: Number(gdo2),
      threshold: Number(threshold),
      windowMs: Number(windowMs),
      onMessage: (message) => {
        console.log(`[live] ${message}`);
      },
    });

    await this.protocolRuntime.start();
  }

  async startSignalDetect(gdo0 = 24, threshold = 100, lookbackMs = 1000, settleMs = 220) {
    await this.stopListening();
    await this.stopProtocolRuntime();
    await this.disconnect();

    this.protocolRuntime = new CC1101SignalDetector({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
      gdo0: Number(gdo0),
      threshold: Number(threshold),
      lookbackMs: Number(lookbackMs),
      settleMs: Number(settleMs),
      onMessage: (message) => {
        console.log(`[signal] ${message}`);
      },
    });

    await this.protocolRuntime.start();
  }

  async startFixedTiming(gdo0 = 24, threshold = 100, baseUs = 500, lookbackMs = 1000) {
    await this.stopListening();
    await this.stopProtocolRuntime();
    await this.disconnect();

    this.protocolRuntime = new CC1101FixedTimingDetector({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
      gdo0: Number(gdo0),
      threshold: Number(threshold),
      baseUs: Number(baseUs),
      lookbackMs: Number(lookbackMs),
      onMessage: (message) => {
        console.log(`[timing] ${message}`);
      },
    });

    await this.protocolRuntime.start();
  }

  async startSegmentCollect(gdo0 = 24, threshold = 100, baseUs = 400, lookbackMs = 500) {
    await this.stopListening();
    await this.stopProtocolRuntime();
    await this.disconnect();

    this.protocolRuntime = new CC1101SegmentCollector({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
      gdo0: Number(gdo0),
      threshold: Number(threshold),
      baseUs: Number(baseUs),
      lookbackMs: Number(lookbackMs),
      onMessage: (message) => {
        console.log(`[segment] ${message}`);
      },
    });

    await this.protocolRuntime.start();
  }

  async startBurstMatch(gpio = 24, silenceGapUs = 10000, minEdges = 16, baseUnitUs = 0) {
    await this.stopListening();
    await this.stopProtocolRuntime();
    await this.disconnect();

    this.protocolRuntime = new CC1101BurstMatcher({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
      gpio: Number(gpio),
      silenceGapUs: Number(silenceGapUs),
      minEdges: Number(minEdges),
      baseUnitUs: Number(baseUnitUs) || null,
      onMessage: (message) => {
        console.log(`[burst] ${message}`);
      },
    });

    await this.protocolRuntime.start();
  }

  async startCanonicalBuild(gpio = 24, silenceGapUs = 10000, minEdges = 16, baseUnitUs = 0) {
    await this.stopListening();
    await this.stopProtocolRuntime();
    await this.disconnect();

    this.protocolRuntime = new CC1101CanonicalFrameBuilder({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
      gpio: Number(gpio),
      silenceGapUs: Number(silenceGapUs),
      minEdges: Number(minEdges),
      baseUnitUs: Number(baseUnitUs) || null,
      onMessage: (message) => {
        console.log(`[canon] ${message}`);
      },
    });

    await this.protocolRuntime.start();
  }

  async startFrameStabilize(gdo0 = 24, threshold = 100, baseUs = 500, lookbackMs = 1000) {
    await this.stopListening();
    await this.stopProtocolRuntime();
    await this.disconnect();

    this.protocolRuntime = new CC1101FrameStabilizer({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
      gdo0: Number(gdo0),
      threshold: Number(threshold),
      baseUs: Number(baseUs),
      lookbackMs: Number(lookbackMs),
      onMessage: (message) => {
        console.log(`[stabilize] ${message}`);
      },
    });

    await this.protocolRuntime.start();
  }

  async startConsensus(gdo0 = 24, threshold = 100, baseUs = 400, beforeMs = 1000, afterMs = 1000) {
    await this.stopListening();
    await this.stopProtocolRuntime();
    await this.disconnect();

    this.protocolRuntime = new CC1101WindowConsensus({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
      gdo0: Number(gdo0),
      threshold: Number(threshold),
      baseUs: Number(baseUs),
      beforeMs: Number(beforeMs),
      afterMs: Number(afterMs),
      onMessage: (message) => {
        console.log(`[consensus] ${message}`);
      },
    });

    await this.protocolRuntime.start();
  }

  async startSliceInspect(gdo0 = 24, threshold = 100, baseUs = 400, beforeMs = 1000, afterMs = 1000) {
    await this.stopListening();
    await this.stopProtocolRuntime();
    await this.disconnect();

    this.protocolRuntime = new CC1101ManualSlicer({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
      gdo0: Number(gdo0),
      threshold: Number(threshold),
      baseUs: Number(baseUs),
      beforeMs: Number(beforeMs),
      afterMs: Number(afterMs),
      onMessage: (message) => {
        console.log(`[slice] ${message}`);
      },
    });

    await this.protocolRuntime.start();
  }

  async startFrameExtract(gdo0 = 24, gdo2 = 25, threshold = 100, silenceGapUs = 8000, minEdges = 12) {
    await this.stopListening();
    await this.stopProtocolRuntime();
    await this.disconnect();

    this.protocolRuntime = new CC1101FrameExtractor({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
      gdo0: Number(gdo0),
      gdo2: Number(gdo2),
      threshold: Number(threshold),
      silenceGapUs: Number(silenceGapUs),
      minEdges: Number(minEdges),
      onMessage: (message) => {
        console.log(`[frame] ${message}`);
      },
    });

    await this.protocolRuntime.start();
  }

  async startWindowCapture(
    rxDataGpio = 24,
    threshold = 100,
    baseUs = 400,
    beforeMs = 1000,
    afterMs = 1000,
    outDir = "/tmp/rf-captures"
  ) {
    await this.stopListening();
    await this.stopProtocolRuntime();
    await this.disconnect();

    this.protocolRuntime = new CC1101WindowCapture({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
      rxDataGpio: Number(rxDataGpio),
      threshold: Number(threshold),
      baseUs: Number(baseUs),
      beforeMs: Number(beforeMs),
      afterMs: Number(afterMs),
      outDir: String(outDir),
      onMessage: (message) => {
        console.log(`[window] ${message}`);
      },
    });

    await this.protocolRuntime.start();
  }

  async saveCapture(rxDataGpio = 24, threshold = 100, baseUs = 400, beforeMs = 1000, afterMs = 1000, outDir = "/tmp/rf-captures") {
    await this.startWindowCapture(rxDataGpio, threshold, baseUs, beforeMs, afterMs, outDir);
  }

  async replayWindow(file, txDataGpio = 24, mode = "normalized", repeats = 10, baseUs) {
    if (!file) {
      throw new Error("window replay requires a capture file path");
    }

    await this.stopListening();
    await this.stopProtocolRuntime();
    await this.disconnect();

    const capture = loadSavedCaptureFile(file);
    const replay = buildReplayFromCapture(capture, {
      mode: /** @type {"raw" | "normalized"} */ (mode === "raw" ? "raw" : "normalized"),
      baseUs: baseUs !== undefined ? Number(baseUs) : undefined,
    });

    const replayer = new CC1101WindowReplayer({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
      txDataGpio: Number(txDataGpio),
      repeats: Number(repeats),
      onMessage: (message) => {
        console.log(`[replay] ${message}`);
      },
    });

    await replayer.replay(replay);
  }

  showCapture(file) {
    if (!file) {
      throw new Error("capture show requires a capture file path");
    }

    const capture = loadSavedCaptureFile(file);
    const summary = summarizeCaptureFile(capture);
    console.log(JSON.stringify({
      file,
      ...summary,
    }, null, 2));
  }

  async stopProtocolRuntime() {
    if (!this.protocolRuntime) return;

    const runtime = this.protocolRuntime;
    this.protocolRuntime = null;
    await runtime.stop();
    console.log("protocol runtime stopped");
  }

  async sampleRssi(count = 10, intervalMs = 100) {
    await this.ensureConnected();

    if (this.radioConfig.mode === RADIO_MODE.DIRECT_ASYNC) {
      await this.radio.startDirectAsyncRx(this.radioConfig);
    } else {
      await this.radio.startPacketRx(this.radioConfig);
    }

    for (let i = 0; i < Number(count); i += 1) {
      const raw = await this.radio.getRssi();
      console.log(
        `[rssi ${i + 1}/${count}] raw=${raw} dbm=${decodeRssi(raw).toFixed(1)}`
      );
      if (i < count - 1) {
        await sleep(Number(intervalMs));
      }
    }
  }

  async transmit(payloadParts) {
    await this.ensureConnected();

    if (!payloadParts.length) {
      throw new Error("tx requires at least one payload byte");
    }

    if (this.radioConfig.mode !== RADIO_MODE.PACKET) {
      throw new Error("tx currently supports packet mode only");
    }

    const payload = parsePayload(payloadParts.join(" "));
    await this.radio.transmitPacket(payload, this.radioConfig);
    console.log(`tx payload=[${hex(payload)}]`);
  }

  async idle() {
    await this.ensureConnected();
    await this.stopListening();
    await this.stopProtocolRuntime();
    await this.radio.idle();
    console.log("radio idle");
  }
}

async function executeCommand(shell, line, onExit) {
  const tokens = parseLine(line.trim());

  if (!tokens.length) {
    return;
  }

  const [command, subcommand, ...rest] = tokens;

  if (command === "help") {
    shell.printHelp();
  } else if (command === "connect") {
    await shell.connect(subcommand, rest[0], rest[1]);
  } else if (command === "disconnect") {
    await shell.disconnect();
    console.log("disconnected");
  } else if (command === "reset") {
    await shell.reset();
  } else if (command === "info") {
    await shell.printInfo();
  } else if (command === "status") {
    await shell.printStatus();
  } else if (command === "config" && subcommand === "show") {
    shell.printConfig();
  } else if (command === "config" && subcommand === "set") {
    shell.setConfig(rest[0], rest[1], rest[2]);
  } else if (command === "gpio" && subcommand === "set") {
    shell.setGpio(rest[0], rest[1], rest[2]);
  } else if (command === "listen" && subcommand === "start") {
    void shell.startListening(Number(rest[0] ?? 20)).catch((error) => {
      console.error(`listen failed: ${error.message}`);
    });
  } else if (command === "listen" && subcommand === "stop") {
    await shell.stopListening();
  } else if (command === "live" && subcommand === "view") {
    await shell.startLiveView(
      Number(rest[0] ?? 24),
      Number(rest[1] ?? 25),
      Number(rest[2] ?? 100),
      Number(rest[3] ?? 3000)
    );
  } else if (command === "raw" && subcommand === "listen") {
    await shell.startRawListen(
      Number(rest[0] ?? 24),
      Number(rest[1] ?? 100),
      Number(rest[2] ?? 220)
    );
  } else if (command === "signal" && subcommand === "detect") {
    await shell.startSignalDetect(
      Number(rest[0] ?? 24),
      Number(rest[1] ?? 100),
      Number(rest[2] ?? 1000),
      Number(rest[3] ?? 220)
    );
  } else if (command === "timing" && subcommand === "fixed") {
    await shell.startFixedTiming(
      Number(rest[0] ?? 24),
      Number(rest[1] ?? 100),
      Number(rest[2] ?? 500),
      Number(rest[3] ?? 1000)
    );
  } else if (command === "segment" && subcommand === "collect") {
    await shell.startSegmentCollect(
      Number(rest[0] ?? 24),
      Number(rest[1] ?? 100),
      Number(rest[2] ?? 400),
      Number(rest[3] ?? 500)
    );
  } else if (command === "burst" && subcommand === "match") {
    await shell.startBurstMatch(
      Number(rest[0] ?? 24),
      Number(rest[1] ?? 10000),
      Number(rest[2] ?? 16),
      Number(rest[3] ?? 0)
    );
  } else if (command === "canonical" && subcommand === "build") {
    await shell.startCanonicalBuild(
      Number(rest[0] ?? 24),
      Number(rest[1] ?? 10000),
      Number(rest[2] ?? 16),
      Number(rest[3] ?? 0)
    );
  } else if (command === "stabilize" && subcommand === "frame") {
    await shell.startFrameStabilize(
      Number(rest[0] ?? 24),
      Number(rest[1] ?? 100),
      Number(rest[2] ?? 500),
      Number(rest[3] ?? 1000)
    );
  } else if (command === "consensus" && subcommand === "start") {
    await shell.startConsensus(
      Number(rest[0] ?? 24),
      Number(rest[1] ?? 100),
      Number(rest[2] ?? 400),
      Number(rest[3] ?? 1000),
      Number(rest[4] ?? 1000)
    );
  } else if (command === "slice" && subcommand === "inspect") {
    await shell.startSliceInspect(
      Number(rest[0] ?? 24),
      Number(rest[1] ?? 100),
      Number(rest[2] ?? 400),
      Number(rest[3] ?? 1000),
      Number(rest[4] ?? 1000)
    );
  } else if (command === "frame" && subcommand === "extract") {
    await shell.startFrameExtract(
      Number(rest[0] ?? 24),
      Number(rest[1] ?? 25),
      Number(rest[2] ?? 100),
      Number(rest[3] ?? 8000),
      Number(rest[4] ?? 12)
    );
  } else if (command === "capture" && subcommand === "save") {
    await shell.saveCapture(
      Number(rest[0] ?? 24),
      Number(rest[1] ?? 100),
      Number(rest[2] ?? 400),
      Number(rest[3] ?? 1000),
      Number(rest[4] ?? 1000),
      rest[5] ?? "/tmp/rf-captures"
    );
  } else if (command === "capture" && subcommand === "show") {
    shell.showCapture(rest[0]);
  } else if (command === "capture" && subcommand === "replay") {
    await shell.replayWindow(
      rest[0],
      Number(rest[1] ?? 24),
      rest[2] ?? "normalized",
      Number(rest[3] ?? 10),
      rest[4] !== undefined ? Number(rest[4]) : undefined
    );
  } else if (command === "window" && subcommand === "capture") {
    await shell.startWindowCapture(
      Number(rest[0] ?? 24),
      Number(rest[1] ?? 100),
      Number(rest[2] ?? 400),
      Number(rest[3] ?? 1000),
      Number(rest[4] ?? 1000),
      rest[5] ?? "/tmp/rf-captures"
    );
  } else if (command === "window" && subcommand === "replay") {
    await shell.replayWindow(
      rest[0],
      Number(rest[1] ?? 24),
      rest[2] ?? "normalized",
      Number(rest[3] ?? 10),
      rest[4] !== undefined ? Number(rest[4]) : undefined
    );
  } else if (command === "protocol" && subcommand === "detect") {
    await shell.startProtocolDetection(
      Number(rest[0] ?? 24),
      Number(rest[1] ?? 100),
      Number(rest[2] ?? 375)
    );
  } else if (command === "protocol" && subcommand === "listen") {
    await shell.startProtocolListen(
      rest[0] ?? "ev1527_like",
      Number(rest[1] ?? 24),
      Number(rest[2] ?? 100),
      Number(rest[3] ?? 375),
      Number(rest[4] ?? 1)
    );
  } else if (command === "protocol" && subcommand === "stop") {
    await shell.stopProtocolRuntime();
  } else if (command === "rssi") {
    await shell.sampleRssi(Number(subcommand ?? 10), Number(rest[0] ?? 100));
  } else if (command === "tx") {
    await shell.transmit([subcommand, ...rest].filter(Boolean));
  } else if (command === "idle") {
    await shell.idle();
  } else if (command === "quit" || command === "exit") {
    onExit();
  } else {
    console.log("unknown command; type `help`");
  }
}

function createStatusText(shell) {
  const config = shell.radioConfig;
  const runtime = shell.listening ? "packet-listen" : shell.protocolRuntime ? "analysis-runtime" : "idle";
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
    ? `${COLOR.magenta}packet-listen${COLOR.reset}`
    : shell.protocolRuntime
      ? `${COLOR.magenta}analysis-runtime${COLOR.reset}`
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

async function main() {
  const args = parseArgs(process.argv);
  const bus = Number(args.bus ?? 0);
  const device = Number(args.device ?? 0);
  const speedHz = Number(args.speed ?? 100000);
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
      const hadActiveRuntime = shell.listening || Boolean(shell.protocolRuntime);
      await shell.stopListening();
      await shell.stopProtocolRuntime();

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
