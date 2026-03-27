// @ts-check

const { STATUS } = require("../cc1101/constants");
const { BAND, MODULATION, PACKET_LENGTH_MODE, RADIO_MODE } = require("../cc1101/profiles");
const appConfig = require("../config");

/**
 * @typedef {import("../cc1101/profiles").Band} Band
 * @typedef {import("../cc1101/profiles").Modulation} Modulation
 * @typedef {import("../cc1101/profiles").RadioMode} RadioMode
 * @typedef {import("../cc1101/profiles").RadioConfigOptions} RadioConfigOptions
 */

const MARCSTATE_MAP = {
  0x00: "SLEEP",
  0x01: "IDLE",
  0x0d: "RX",
  0x11: "RX_OVERFLOW",
  0x13: "TX",
  0x16: "TX_UNDERFLOW",
};

/**
 * @returns {RadioConfigOptions}
 */
function createDefaultRadioConfig() {
  return {
    band: appConfig.radio.band,
    modulation: appConfig.radio.modulation,
    mode: appConfig.radio.mode,
    packet: {
      appendStatus: true,
      lengthMode: PACKET_LENGTH_MODE.VARIABLE,
    },
    gpio: {},
  };
}

/**
 * @param {number} raw
 * @returns {number}
 */
function decodeRssi(raw) {
  let value = raw;
  if (value >= 128) value -= 256;
  return (value / 2) - 74;
}

/**
 * @param {string | undefined} value
 * @param {Band} fallback
 * @returns {Band}
 */
function parseBand(value, fallback) {
  if (!value) return fallback;
  if (Object.values(BAND).includes(value)) return value;
  throw new Error(`Invalid band: ${value}`);
}

/**
 * @param {string | undefined} value
 * @param {Modulation} fallback
 * @returns {Modulation}
 */
function parseModulation(value, fallback) {
  if (!value) return fallback;
  const normalized = value.toLowerCase();
  if (Object.values(MODULATION).includes(normalized)) return normalized;
  throw new Error(`Invalid modulation: ${value}`);
}

/**
 * @param {string | undefined} value
 * @param {RadioMode} fallback
 * @returns {RadioMode}
 */
function parseMode(value, fallback) {
  if (!value) return fallback;
  if (Object.values(RADIO_MODE).includes(value)) return value;
  throw new Error(`Invalid mode: ${value}`);
}

/**
 * @param {string | number | boolean | undefined | null} value
 * @param {boolean=} fallback
 * @returns {boolean}
 */
function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;

  const normalized = String(value).toLowerCase();
  if (["1", "true", "yes", "on", "invert", "inverted"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "normal"].includes(normalized)) return false;

  throw new Error(`Invalid boolean flag: ${value}`);
}

/**
 * @param {{ readRegister(address: number): Promise<number> }} radio
 * @param {number} address
 * @returns {Promise<number>}
 */
async function stableRead(radio, address) {
  let previous = await radio.readRegister(address);
  for (let i = 0; i < 3; i += 1) {
    const current = await radio.readRegister(address);
    if (current === previous) return current;
    previous = current;
  }
  return previous;
}

module.exports = {
  STATUS,
  RADIO_MODE,
  MARCSTATE_MAP,
  appConfig,
  createDefaultRadioConfig,
  decodeRssi,
  parseBand,
  parseBooleanFlag,
  parseModulation,
  parseMode,
  stableRead,
};
