// @ts-check

/** @typedef {import("./types").CommandDefinition} CommandDefinition */

/** @type {CommandDefinition} */
module.exports = {
  name: "man",
  help: "man [command]",
  man: [
    "NAME",
    "  man - show detailed shell command documentation",
    "",
    "USAGE",
    "  man",
    "  man <command>",
    "",
    "DESCRIPTION",
    "  Without arguments, lists the commands that have manual entries.",
    "  With a command name, prints detailed usage, behavior, and option meanings.",
    "",
    "EXAMPLES",
    "  man mode",
    "  man listen",
    "  man replay",
  ].join("\n"),
  async execute({ args, registry }) {
    const [commandName] = args;

    if (!commandName) {
      console.log("manual entries:");
      console.log(`  ${registry.commands.map((command) => command.name).sort().join(", ")}`);
      console.log("use `man <command>` for details");
      return;
    }

    const command = registry.findCommand(commandName);
    if (!command || !command.man) {
      console.log(`no manual entry for \`${commandName}\``);
      return;
    }

    console.log(command.man);
  },
};
