// @ts-check

const appConfig = require("../config");
const { CC1101RawListener } = require("../cc1101/analysis/raw-listener");
const { hex, sleep } = require("../cc1101/utils");
const { RADIO_MODE } = require("./helpers");

/** @typedef {import("./types").CommandDefinition} CommandDefinition */

/** @type {CommandDefinition} */
module.exports = {
  name: "listen",
  help: "listen [pollMs]",
  helpExamples: [
    "mode packet 433 ook",
    "listen 20",
    "send aa 55 01",
    "mode direct_async 433 ook",
    `listen ${appConfig.directAsync.rx.silenceGapUs} 250`,
  ],
  runInBackground: true,
  man: [
    "NAME",
    "  listen - receive traffic using the current shell mode",
    "",
    "USAGE",
    "  listen [pollMs]",
    "  listen [silenceGapUs] [sampleRateUs]",
    "",
    "MODE BEHAVIOR",
    "  packet mode",
    "    listen [pollMs]",
    "    Starts FIFO packet receive polling.",
    "  direct_async mode",
    "    listen [silenceGapUs] [sampleRateUs]",
    "    Starts a raw OOK edge listener with two states:",
    "    silence -> signal_detected -> silence.",
    "    The edges collected between those state transitions are emitted as one raw signal window.",
    "",
    "OPTIONS",
    "  pollMs",
    "    Packet mode only. Delay between FIFO polling passes. Default 20 ms.",
    "  silenceGapUs",
    "    Direct-async mode only. If no new edge arrives for at least this many microseconds,",
    "    the current signal is considered finished and the listener returns to silence.",
    `    Default ${appConfig.directAsync.rx.silenceGapUs} us.`,
    "  sampleRateUs",
    "    Direct-async mode only. Preferred bit unit size for the live `bits` row.",
    "    This affects rendering only and does not filter live edges.",
    "",
    "DESCRIPTION",
    `  Direct-async RX pin routing is taken from config.js (default Pi GPIO ${appConfig.directAsync.rx.gpio}).`,
    "  Every silence-delimited signal is emitted, including single-edge signals.",
    "  Stops any existing runtime before starting a new listener.",
    "  Stop it with `stop`, `idle`, `disconnect`, or Ctrl+C.",
  ].join("\n"),
  async execute({ shell, args }) {
    if (shell.radioConfig.mode === RADIO_MODE.PACKET) {
      const pollMs = Number(args[0] ?? 20);
      await shell.ensureConnected();
      await shell.stop();
      await shell.radio.startPacketRx(shell.radioConfig);
      shell.listening = true;

      console.log(`packet listen started pollMs=${pollMs}`);

      while (shell.listening) {
        const result = await shell.radio.readFifoPacket();

        if (result.overflow) {
          console.log("[rx] overflow");
        } else if (result.invalidLength) {
          console.log(`[rx] invalid length=${result.invalidLength}`);
        } else if (result.packet) {
          console.log(
            `[rx] len=${result.packet.length} payload=[${hex(result.packet.payload)}] status=[${hex(result.packet.status)}]`
          );
        }

        await sleep(pollMs);
      }
      return;
    }

    await shell.stop();
    await shell.disconnect();

    shell.runtime = new CC1101RawListener({
      bus: shell.bus,
      device: shell.device,
      speedHz: shell.speedHz,
      gpio: appConfig.directAsync.rx.gpio,
      silenceGapUs: Number(args[0] ?? appConfig.directAsync.rx.silenceGapUs),
      bitUnitUs: args[1] !== undefined ? Number(args[1]) : undefined,
      onMessage: (message) => {
        console.log(`[async] ${message}`);
      },
    });

    await shell.runtime.start();
  },
};
