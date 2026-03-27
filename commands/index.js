// @ts-check

const help = require("./help");
const man = require("./man");
const connect = require("./connect");
const disconnect = require("./disconnect");
const status = require("./status");
const mode = require("./mode");
const listen = require("./listen");
const send = require("./send");
const record = require("./record");
const replay = require("./replay");
const show = require("./show");
const stop = require("./stop");
const idle = require("./idle");
const clear = require("./clear");
const quit = require("./quit");

/** @typedef {import("./types").CommandDefinition} CommandDefinition */
/** @typedef {import("./types").CommandRegistry} CommandRegistry */

/** @type {CommandDefinition[]} */
const COMMANDS = [
  help,
  man,
  connect,
  disconnect,
  status,
  mode,
  listen,
  send,
  record,
  replay,
  show,
  stop,
  idle,
  clear,
  quit,
];

function createCommandRegistry() {
  /** @type {Map<string, CommandDefinition>} */
  const byName = new Map();

  for (const command of COMMANDS) {
    const keys = [command.name, ...(command.aliases ?? [])];
    for (const key of keys) {
      if (byName.has(key)) {
        throw new Error(`Duplicate command registration: ${key}`);
      }
      byName.set(key, command);
    }
  }

  /** @type {CommandRegistry} */
  const registry = {
    commands: COMMANDS,
    findCommand(name) {
      return byName.get(String(name).toLowerCase()) ?? null;
    },
  };

  return registry;
}

module.exports = { createCommandRegistry };
