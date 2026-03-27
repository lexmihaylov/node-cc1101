// @ts-check

/** @typedef {import("./types").CommandDefinition} CommandDefinition */

/** @type {CommandDefinition} */
module.exports = {
  name: "quit",
  aliases: ["exit"],
  help: "quit",
  man: [
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
  async execute({ onExit }) {
    onExit();
  },
};
