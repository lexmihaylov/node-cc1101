// @ts-check

const appConfig = require("../config");
const {
  DEFAULT_MINIMUM_PULSE_WIDTH_US,
  loadCaptureFile,
  renderRawSignal,
  renderSegmentedFrames,
  summarizeCaptureFile,
} = require("../cc1101/analysis/capture-file");

/** @typedef {import("./types").CommandDefinition} CommandDefinition */

/** @type {CommandDefinition} */
module.exports = {
  name: "show",
  help: "show <file> [silenceGapUs] [sampleRateUs]",
  helpExamples: [
    `show /tmp/rf-captures/session-001.json ${appConfig.directAsync.rx.silenceGapUs} 250`,
    `replay /tmp/rf-captures/session-001.json 0 ${appConfig.directAsync.rx.silenceGapUs} 250 ${appConfig.directAsync.tx.repeats} false`,
  ],
  man: [
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
  async execute({ shell, args }) {
    const [
      file,
      silenceGapUs = appConfig.directAsync.rx.silenceGapUs,
      sampleRateUs = appConfig.directAsync.filter.minimumPulseWidthUs,
    ] = args;

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
  },
};
