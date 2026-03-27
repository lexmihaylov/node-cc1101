// @ts-check

const appConfig = require("../config");
const { buildReplayFromCapture, CC1101WindowReplayer } = require("../cc1101/analysis/window-replay");
const { loadCaptureFile, DEFAULT_MINIMUM_PULSE_WIDTH_US } = require("../cc1101/analysis/capture-file");
const { parseBooleanFlag } = require("./helpers");

/** @typedef {import("./types").CommandDefinition} CommandDefinition */

/** @type {CommandDefinition} */
module.exports = {
  name: "replay",
  help: "replay <file> [frameIndex] [silenceGapUs] [sampleRateUs] [repeats] [invert]",
  man: [
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
  async execute({ shell, args }) {
    const [
      file,
      frameIndex = 0,
      silenceGapUs = appConfig.directAsync.rx.silenceGapUs,
      sampleRateUs = appConfig.directAsync.filter.minimumPulseWidthUs,
      repeats = appConfig.directAsync.tx.repeats,
      invert = appConfig.directAsync.tx.invert,
    ] = args;

    if (!file) {
      throw new Error("replay requires a capture file path");
    }

    await shell.stop();
    await shell.disconnect();

    const capture = loadCaptureFile(file);
    const replay = buildReplayFromCapture(capture, {
      frameIndex: Number(frameIndex),
      silenceGapUs: Number(silenceGapUs),
      minimumPulseWidthUs: Number(sampleRateUs),
    });

    const replayer = new CC1101WindowReplayer({
      bus: shell.bus,
      device: shell.device,
      speedHz: shell.speedHz,
      txDataGpio: appConfig.directAsync.tx.gpio,
      repeats: Number(repeats),
      invert: parseBooleanFlag(invert, false),
      onMessage: (message) => {
        console.log(`[replay] ${message}`);
      },
    });

    await replayer.replay(replay);
  },
};
