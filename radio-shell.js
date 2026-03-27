#!/usr/bin/env node

const fs = require("fs");
const readline = require("readline");
const { CC1101RawListener } = require("./cc1101/analysis/raw-listener");
const { CC1101StreamRecorder } = require("./cc1101/analysis/stream-recorder");
const {
  DEFAULT_GLITCH_PULSE_US,
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
    "    SPI clock speed in Hz. Default is the current shell speed, usually 100000.",
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
    "    RF band preset. Supported values: 433, 868, 915.",
    "  modulation",
    "    Radio modulation. Supported values: ook, fsk.",
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
    "  listen [gpio] [silenceGapUs]",
    "",
    "MODE BEHAVIOR",
    "  packet mode",
    "    listen [pollMs]",
    "    Starts FIFO packet receive polling.",
    "  direct_async mode",
    "    listen [gpio] [silenceGapUs]",
    "    Starts a raw OOK edge listener with two states:",
    "    silence -> signal_detected -> silence.",
    "    The edges collected between those state transitions are emitted as one raw signal window.",
    "",
    "OPTIONS",
    "  pollMs",
    "    Packet mode only. Delay between FIFO polling passes. Default 20 ms.",
    "  gpio",
    "    Direct-async mode only. Raspberry Pi GPIO connected to CC1101 GDO0. Default 24.",
    "  silenceGapUs",
    "    Direct-async mode only. If no new edge arrives for at least this many microseconds,",
    "    the current signal is considered finished and the listener returns to silence.",
    "    Default 10000 us.",
    "",
    "DESCRIPTION",
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
    "  send <file> [frameIndex] [silenceGapUs] [txDataGpio] [repeats] [invert]",
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
    "    For raw stream files, split frames using this silence threshold. Default 10000 us.",
    "  txDataGpio",
    "    Raspberry Pi output GPIO driving the CC1101 GDO0 TX data input. Default 24.",
    "  repeats",
    "    Number of transmissions. Default 10.",
    "  invert",
    "    Invert replay polarity. Accepts true/false, 1/0, yes/no, invert/normal.",
    "    Default false.",
    "",
    "DESCRIPTION",
    "  Use `send` instead of separate TX verbs. In packet mode it writes FIFO data.",
    "  In direct_async mode it replays the saved raw edge timing file after applying",
    `  the built-in short pulse glitch suppressor (${DEFAULT_GLITCH_PULSE_US} us).`,
  ].join("\n"),
  record: [
    "NAME",
    "  record - capture one continuous direct-async edge stream to a file",
    "",
    "USAGE",
    "  record <file> [rxDataGpio]",
    "",
    "OPTIONS",
    "  file",
    "    Output JSON file that receives the full recorded edge stream.",
    "  rxDataGpio",
    "    Raspberry Pi input GPIO connected to CC1101 GDO0. Default 24.",
    "",
    "DESCRIPTION",
    "  Stores the raw edge stream exactly as seen on the GPIO line.",
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
    "  replay <file> [frameIndex] [silenceGapUs] [txDataGpio] [repeats] [invert]",
    "",
    "OPTIONS",
    "  file",
    "    Saved raw stream or replayable raw edge JSON file.",
    "  frameIndex",
    "    For raw stream files, replay this identified frame. Default 0.",
    "  silenceGapUs",
    "    For raw stream files, split frames using this silence threshold. Default 10000 us.",
    "  txDataGpio",
    "    Raspberry Pi output GPIO driving CC1101 GDO0 in TX. Default 24.",
    "  repeats",
    "    Number of times to transmit the sequence. Default 10.",
    "  invert",
    "    Invert replay polarity. Accepts true/false, 1/0, yes/no, invert/normal.",
    "    Default false.",
    "",
    "DESCRIPTION",
    "  Stops active work, puts the radio into direct async TX, segments the file into frames",
    "  using the supplied silence threshold, and replays the selected frame as recorded edge events",
    "  rebased to the start of that frame.",
    `  A built-in short pulse glitch suppressor (${DEFAULT_GLITCH_PULSE_US} us) is applied`,
    "  to the extracted frame before replay.",
  ].join("\n"),
  show: [
    "NAME",
    "  show - summarize a saved JSON file",
    "",
    "USAGE",
    "  show <file> [silenceGapUs]",
    "",
    "OPTIONS",
    "  file",
    "    Any saved stream/frame/capture JSON file.",
    "  silenceGapUs",
    "    For raw stream files, split frames using this silence threshold. Default 10000 us.",
    "",
    "DESCRIPTION",
    "  Prints a short summary including timestamp, edge count, and top-level fields.",
    "  For raw edge files, it also segments the stream into silence-delimited frames and renders",
    "  each frame with a compact shape row and a scaled high/low timeline so similar captures",
    "  can be compared visually without changing the stored timings.",
    "  Every identified frame is shown, including single-edge frames.",
    `  A built-in short pulse glitch suppressor (${DEFAULT_GLITCH_PULSE_US} us) is applied`,
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
    this.bus = options.bus ?? 0;
    this.device = options.device ?? 0;
    this.speedHz = options.speedHz ?? 100000;
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
    console.log("  mode [packet|direct_async] [band] [modulation]");
    console.log("  listen [pollMs|gpio] [silenceGapUs]");
    console.log("  send <hex-bytes...>");
    console.log("  send <file> [frameIndex] [silenceGapUs] [txDataGpio] [repeats] [invert]");
    console.log("  record <file> [rxDataGpio]");
    console.log("  replay <file> [frameIndex] [silenceGapUs] [txDataGpio] [repeats] [invert]");
    console.log("  show <file> [silenceGapUs]");
    console.log("  stop");
    console.log("  idle");
    console.log("  clear");
    console.log("  quit");
    console.log("");
    console.log("examples:");
    console.log("  man listen");
    console.log("  mode packet 433 ook");
    console.log("  listen 20");
    console.log("  send aa 55 01");
    console.log("  mode direct_async 433 ook");
    console.log("  listen 24 10000");
    console.log("  record /tmp/rf-captures/session-001.json 24");
    console.log("  stop");
    console.log("  show /tmp/rf-captures/session-001.json 10000");
    console.log("  replay /tmp/rf-captures/session-001.json 0 10000 24 10 false");
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

  async startDirectAsyncListen(gpio = 24, silenceGapUs = 10000) {
    await this.stop();
    await this.disconnect();

    this.runtime = new CC1101RawListener({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
      gpio: Number(gpio),
      silenceGapUs: Number(silenceGapUs),
      onMessage: (message) => {
        console.log(`[async] ${message}`);
      },
    });

    await this.runtime.start();
  }

  async listen(arg0, arg1, arg2, arg3) {
    if (this.radioConfig.mode === RADIO_MODE.PACKET) {
      await this.startPacketListen(Number(arg0 ?? 20));
      return;
    }

    await this.startDirectAsyncListen(
      Number(arg0 ?? 24),
      Number(arg1 ?? 10000)
    );
  }

  async replay(file, frameIndex = 0, silenceGapUs = 10000, txDataGpio = 24, repeats = 10, invert = false) {
    if (!file) {
      throw new Error("replay requires a capture file path");
    }

    await this.stop();
    await this.disconnect();

    const capture = loadCaptureFile(file);
    const replay = buildReplayFromCapture(capture, {
      frameIndex: Number(frameIndex),
      silenceGapUs: Number(silenceGapUs),
    });

    const replayer = new CC1101WindowReplayer({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
      txDataGpio: Number(txDataGpio),
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

    const [file, frameIndex, silenceGapUs, txDataGpio, repeats, invert] = args;
    if (!fs.existsSync(String(file))) {
      throw new Error("direct_async send requires a replayable file path");
    }

    await this.replay(file, frameIndex ?? 0, silenceGapUs ?? 10000, txDataGpio ?? 24, repeats ?? 10, invert ?? false);
  }

  async record(file, rxDataGpio = 24) {
    if (!file) {
      throw new Error("record requires an output file path");
    }

    await this.stop();
    await this.disconnect();

    const renderLiveRecordFrame = (frame) => {
      const header = [
        `${COLOR.cyan}record${COLOR.reset} ${COLOR.dim}| live preview${COLOR.reset}`,
        `${COLOR.blue}file${COLOR.reset}=${file}  ${COLOR.blue}gpio${COLOR.reset}=${Number(rxDataGpio)}`,
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
      rxDataGpio: Number(rxDataGpio),
      onMessage: (message) => {
        console.log(`[record] ${message}`);
      },
      onPreview: (frame) => {
        renderLiveRecordFrame(frame);
      },
    });

    await this.runtime.start();
  }

  show(file, silenceGapUs = 10000) {
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
    });
    if (segmented) {
      console.log("");
      console.log(segmented);
      return;
    }

    const rendered = renderRawSignal(capture, {
      glitchPulseUs: DEFAULT_GLITCH_PULSE_US,
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
  } else if (command === "mode") {
    if (!subcommand) {
      shell.printMode();
    } else {
      shell.setMode(subcommand, rest[0], rest[1]);
    }
  } else if (command === "listen") {
    void shell.listen(subcommand, rest[0], rest[1], rest[2]).catch((error) => {
      console.error(`listen failed: ${error.message}`);
    });
  } else if (command === "send") {
    await shell.send([subcommand, ...rest].filter(Boolean));
  } else if (command === "record") {
    await shell.record(subcommand, rest[0]);
  } else if (command === "replay") {
    await shell.replay(subcommand, rest[0], rest[1], rest[2], rest[3]);
  } else if (command === "show") {
    shell.show(subcommand, rest[0]);
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
