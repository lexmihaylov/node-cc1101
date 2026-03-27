// @ts-check

const appConfig = require("../config");
const fs = require("fs");
const { DEFAULT_MINIMUM_PULSE_WIDTH_US } = require("../cc1101/analysis/capture-file");
const { hex, parsePayload } = require("../cc1101/utils");
const { RADIO_MODE } = require("./helpers");
const replayCommand = require("./replay");

/** @typedef {import("./types").CommandDefinition} CommandDefinition */

/** @type {CommandDefinition} */
module.exports = {
  name: "send",
  help: "send <hex-bytes...>",
  man: [
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
  async execute({ shell, args }) {
    await shell.ensureConnected();

    if (!args.length) {
      throw new Error("send requires payload bytes in packet mode or a file path in direct_async mode");
    }

    if (shell.radioConfig.mode === RADIO_MODE.PACKET) {
      const payload = parsePayload(args.join(" "));
      await shell.radio.transmitPacket(payload, shell.radioConfig);
      console.log(`tx payload=[${hex(payload)}]`);
      return;
    }

    const [file] = args;
    if (!fs.existsSync(String(file))) {
      throw new Error("direct_async send requires a replayable file path");
    }

    await replayCommand.execute({
      shell,
      args: [
        file,
        args[1] ?? 0,
        args[2] ?? appConfig.directAsync.rx.silenceGapUs,
        args[3] ?? appConfig.directAsync.filter.minimumPulseWidthUs,
        args[4] ?? appConfig.directAsync.tx.repeats,
        args[5] ?? appConfig.directAsync.tx.invert,
      ],
    });
  },
};
