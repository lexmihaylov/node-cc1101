// @ts-check

/** @typedef {import("./types").CommandDefinition} CommandDefinition */

/** @type {CommandDefinition} */
module.exports = {
  name: "idle",
  help: "idle",
  man: [
    "NAME",
    "  idle - stop active work and send the radio to IDLE",
    "",
    "USAGE",
    "  idle",
    "",
    "DESCRIPTION",
    "  Equivalent to stopping the active runtime and then issuing SIDLE to the radio.",
  ].join("\n"),
  async execute({ shell }) {
    await shell.ensureConnected();
    await shell.stop();
    await shell.radio.idle();
    console.log("radio idle");
  },
};
