// @ts-check

/** @typedef {import("./types").CommandDefinition} CommandDefinition */

/** @type {CommandDefinition} */
module.exports = {
  name: "disconnect",
  help: "disconnect",
  man: [
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
  async execute({ shell }) {
    await shell.disconnect();
    console.log("disconnected");
  },
};
