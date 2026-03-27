# Command Guide

This project uses a manifest-driven shell command system.

Each shell command lives in its own file under [`commands/`](/home/lex/projects/node-cc1101/commands), and the shell loads commands through [`commands/index.js`](/home/lex/projects/node-cc1101/commands/index.js).

## Command Shape

A command module should export an object with:

- `name`: primary command name
- `aliases`: optional array of alternate names
- `help`: short usage line shown by `help`
- `helpExamples`: optional example lines shown by `help`
- `man`: full manual entry shown by `man <command>`
- `runInBackground`: optional boolean for long-running commands like `listen`
- `execute(context)`: command implementation

Command files should also follow the repo’s JSDoc style so they work well with `// @ts-check`.

Example:

```js
// @ts-check

/**
 * @typedef {object} CommandContext
 * @property {object} shell
 * @property {string[]} args
 * @property {() => void} onExit
 * @property {{ commands: CommandDefinition[], findCommand(name: string): CommandDefinition | null }} registry
 * @property {string} commandName
 *
 * @typedef {object} CommandDefinition
 * @property {string} name
 * @property {string[]=} aliases
 * @property {string} help
 * @property {string[]=} helpExamples
 * @property {string} man
 * @property {boolean=} runInBackground
 * @property {(context: CommandContext) => Promise<void> | void} execute
 */

/** @type {CommandDefinition} */
module.exports = {
  name: "example",
  help: "example [arg]",
  man: [
    "NAME",
    "  example - describe the command",
    "",
    "USAGE",
    "  example [arg]",
  ].join("\n"),
  async execute({ shell, args }) {
    console.log("example", args[0]);
  },
};
```

## JSDoc Types

Use JSDoc typedefs in new command files.

At minimum:

- add `// @ts-check`
- define a `CommandContext` typedef if the file needs one locally
- annotate the exported command object with `/** @type {CommandDefinition} */`

This keeps editor autocomplete and static checking useful without converting the repo to TypeScript.

## Registration

1. Create a new file in [`commands/`](/home/lex/projects/node-cc1101/commands).
2. Import it in [`commands/index.js`](/home/lex/projects/node-cc1101/commands/index.js).
3. Add it to the `COMMANDS` array in [`commands/index.js`](/home/lex/projects/node-cc1101/commands/index.js).

Once registered:

- `help` will include the command automatically from its `help` field
- `man` will include the command automatically from its `man` field
- the shell dispatcher will execute it by `name` or any `aliases`

## Execution Context

`execute(context)` receives:

- `shell`: the live `RadioShell` instance
- `args`: parsed command arguments, excluding the command name
- `onExit`: function used by `quit`/`exit`
- `registry`: the command registry
- `commandName`: the exact command token entered by the user

## Where Logic Belongs

- Put command behavior in the command file itself.
- Put shell-instance lifecycle/state methods on [`RadioShell`](/home/lex/projects/node-cc1101/radio-shell.js), such as `connect()`, `disconnect()`, `ensureConnected()`, and `stop()`.
- Put stateless shared helpers in [`commands/helpers.js`](/home/lex/projects/node-cc1101/commands/helpers.js).
- Do not add command-specific branching back into [`radio-shell.js`](/home/lex/projects/node-cc1101/radio-shell.js).

## Long-Running Commands

If a command runs continuously, set:

```js
runInBackground: true
```

The shell dispatcher will start it without blocking prompt lifecycle handling and will report failures as:

```text
<command> failed: <message>
```

Typical examples are listeners or live runtimes.

## Validation

After adding or changing commands, run:

```bash
npm run check
```

This validates syntax for the shell, the driver code, and all files under [`commands/`](/home/lex/projects/node-cc1101/commands).
