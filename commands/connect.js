// @ts-check

const { appConfig } = require("./helpers");

/** @typedef {import("./types").CommandDefinition} CommandDefinition */

/** @type {CommandDefinition} */
module.exports = {
  name: "connect",
  help: "connect [bus] [device] [speedHz]",
  man: [
    "NAME",
    "  connect - open the SPI connection to the CC1101",
    "",
    "USAGE",
    "  connect [bus] [device] [speedHz]",
    "",
    "OPTIONS",
    "  bus",
    "    SPI bus number. Default is the current shell bus, usually 0.",
    "  device",
    "    SPI chip-select number. Default is the current shell device, usually 0.",
    "  speedHz",
    `    SPI clock speed in Hz. Default is the current shell speed, usually ${appConfig.spi.speedHz}.`,
    "",
    "DESCRIPTION",
    "  Reconnects the shell to the radio using the supplied SPI settings.",
    "  If the shell is already connected, it stops active work, closes the old connection,",
    "  and then opens a new one.",
  ].join("\n"),
  async execute({ shell, args }) {
    await shell.connect(args[0], args[1], args[2]);
  },
};
