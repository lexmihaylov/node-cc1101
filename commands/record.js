// @ts-check

const appConfig = require("../config");
const { CC1101StreamRecorder } = require("../cc1101/analysis/stream-recorder");

/** @typedef {import("./types").CommandDefinition} CommandDefinition */

/** @type {CommandDefinition} */
module.exports = {
  name: "record",
  help: "record <file>",
  helpExamples: [
    "record /tmp/rf-captures/session-001.json",
    "stop",
  ],
  man: [
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
  async execute({ shell, args }) {
    const [file] = args;
    if (!file) {
      throw new Error("record requires an output file path");
    }

    await shell.stop();
    await shell.disconnect();

    const renderLiveRecordFrame = (frame) => {
      const header = [
        "\u001b[36mrecord\u001b[0m \u001b[2m| live preview\u001b[0m",
        `\u001b[34mfile\u001b[0m=${file}  \u001b[34mgpio\u001b[0m=${appConfig.directAsync.rx.gpio}`,
        "\u001b[2mCtrl+C or 'stop' ends recording and saves the stream\u001b[0m",
        "",
      ].join("\n");

      shell.renderFrame(`\u001b[2J\u001b[H${header}${frame}\n`);
    };

    shell.runtime = new CC1101StreamRecorder({
      bus: shell.bus,
      device: shell.device,
      speedHz: shell.speedHz,
      filepath: String(file),
      rxDataGpio: appConfig.directAsync.rx.gpio,
      onMessage: (message) => {
        console.log(`[record] ${message}`);
      },
      onPreview: (frame) => {
        renderLiveRecordFrame(frame);
      },
    });

    await shell.runtime.start();
  },
};
