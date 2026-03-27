// @ts-check

const { STATUS, MARCSTATE_MAP, decodeRssi, stableRead } = require("./helpers");

/** @typedef {import("./types").CommandDefinition} CommandDefinition */

/** @type {CommandDefinition} */
module.exports = {
  name: "status",
  help: "status",
  man: [
    "NAME",
    "  status - print current radio state and status registers",
    "",
    "USAGE",
    "  status",
    "",
    "DESCRIPTION",
    "  Prints MARCSTATE, RSSI, PKTSTATUS, RXBYTES, and TXBYTES.",
    "  Useful for confirming whether the radio is in IDLE, RX, or TX and whether",
    "  FIFO activity looks sane.",
  ].join("\n"),
  async execute({ shell }) {
    await shell.ensureConnected();

    const marc = await stableRead(shell.radio, STATUS.MARCSTATE);
    const rssi = await stableRead(shell.radio, STATUS.RSSI);
    const pktstatus = await stableRead(shell.radio, STATUS.PKTSTATUS);
    const rxbytes = await stableRead(shell.radio, STATUS.RXBYTES);
    const txbytes = await stableRead(shell.radio, STATUS.TXBYTES);

    console.log(`MARCSTATE: ${MARCSTATE_MAP[marc & 0x1f] ?? "UNKNOWN"} (${marc & 0x1f})`);
    console.log(`RSSI raw : ${rssi}`);
    console.log(`RSSI dBm : ${decodeRssi(rssi).toFixed(1)}`);
    console.log(`PKTSTATUS: 0x${pktstatus.toString(16).padStart(2, "0")}`);
    console.log(`RXBYTES  : ${rxbytes & 0x7f}`);
    console.log(`TXBYTES  : ${txbytes & 0x7f}`);
  },
};
