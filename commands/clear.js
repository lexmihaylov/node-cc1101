// @ts-check

/** @typedef {import("./types").CommandDefinition} CommandDefinition */

/** @type {CommandDefinition} */
module.exports = {
  name: "clear",
  help: "clear",
  man: [
    "NAME",
    "  clear - clear the terminal",
    "",
    "USAGE",
    "  clear",
  ].join("\n"),
  async execute() {
    process.stdout.write("\u001bc");
  },
};
