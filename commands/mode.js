// @ts-check

const { RADIO_MODE, parseBand, parseMode, parseModulation } = require("./helpers");
const { PACKET_LENGTH_MODE } = require("../cc1101/profiles");

/** @typedef {import("./types").CommandDefinition} CommandDefinition */

/** @type {CommandDefinition} */
module.exports = {
  name: "mode",
  help: "mode [packet|direct_async] [band] [modulation]",
  man: [
    "NAME",
    "  mode - show or update the shell radio mode configuration",
    "",
    "USAGE",
    "  mode",
    "  mode [packet|direct_async] [band] [modulation]",
    "",
    "OPTIONS",
    "  packet|direct_async",
    "    Selects the operating workflow.",
    "    `packet` is FIFO RX/TX.",
    "    `direct_async` is GPIO-based OOK listen/record/replay.",
    "  band",
    "    RF band preset. Supported values: 315, 433, 868, 915.",
    "  modulation",
    "    Radio modulation. Supported values: ook, fsk, 2fsk, gfsk, msk.",
    "    `fsk` remains a legacy packet preset alias.",
    "    In practice, direct_async is intended for ook.",
    "",
    "DESCRIPTION",
    "  With no arguments, prints the current in-memory shell configuration.",
    "  With arguments, updates the shell defaults used by listen/send/replay.",
  ].join("\n"),
  async execute({ shell, args }) {
    if (!args[0]) {
      console.log(JSON.stringify(shell.radioConfig, null, 2));
      return;
    }

    shell.radioConfig = {
      ...shell.radioConfig,
      mode: parseMode(args[0], shell.radioConfig.mode),
      band: parseBand(args[1], shell.radioConfig.band),
      modulation: parseModulation(args[2], shell.radioConfig.modulation),
      packet: args[0] === RADIO_MODE.PACKET || (!args[0] && shell.radioConfig.mode === RADIO_MODE.PACKET)
        ? {
          appendStatus: true,
          lengthMode: PACKET_LENGTH_MODE.VARIABLE,
        }
        : {
          appendStatus: false,
        },
    };

    console.log("mode updated");
    console.log(JSON.stringify(shell.radioConfig, null, 2));
  },
};
