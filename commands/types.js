// @ts-check

/**
 * Shared JSDoc typedefs for shell commands.
 *
 * @typedef {import("../radio-shell").RadioShell} RadioShell
 *
 * @typedef {object} CommandDefinition
 * @property {string} name
 * @property {string[]=} aliases
 * @property {string} help
 * @property {string[]=} helpExamples
 * @property {string} man
 * @property {boolean=} runInBackground
 * @property {(context: CommandContext) => Promise<void> | void} execute
 *
 * @typedef {object} CommandRegistry
 * @property {CommandDefinition[]} commands
 * @property {(name: string) => CommandDefinition | null} findCommand
 *
 * @typedef {object} CommandContext
 * @property {RadioShell} shell
 * @property {string[]} args
 * @property {() => void} onExit
 * @property {CommandRegistry} registry
 * @property {string} commandName
 */

module.exports = {};
