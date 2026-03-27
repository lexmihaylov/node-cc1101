// @ts-check

/** @typedef {import("./types").CommandDefinition} CommandDefinition */

/** @type {CommandDefinition} */
module.exports = {
  name: "stop",
  help: "stop",
  helpExamples: [
    "stop",
  ],
  man: [
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
  async execute({ shell }) {
    await shell.stop();
    console.log("stopped");
  },
};
