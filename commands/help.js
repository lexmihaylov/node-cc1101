// @ts-check

/** @typedef {import("./types").CommandDefinition} CommandDefinition */

/** @type {CommandDefinition} */
module.exports = {
  name: "help",
  help: "help",
  helpExamples: [
    "man listen",
  ],
  man: [
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
  async execute({ registry }) {
    console.log("commands:");
    for (const command of registry.commands) {
      console.log(`  ${command.help}`);
    }

    const examples = registry.commands.flatMap((command) => command.helpExamples ?? []);
    if (!examples.length) return;

    console.log("");
    console.log("examples:");
    for (const example of examples) {
      console.log(`  ${example}`);
    }
  },
};
