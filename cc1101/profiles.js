// @ts-check

const { REG, VALUE } = require("./constants");

/**
 * @typedef {"433" | "868" | "915"} Band
 * @typedef {"ook" | "fsk"} Modulation
 * @typedef {"packet" | "direct_async"} RadioMode
 * @typedef {"chip_ready_n" | "high_impedance" | "pqi" | "async_serial_data"} GdoSignal
 * @typedef {"fixed" | "variable"} PacketLengthMode
 * @typedef {Record<number, number>} RegisterMap
 *
 * @typedef {object} RadioPacketOptions
 * @property {boolean=} appendStatus
 * @property {PacketLengthMode=} lengthMode
 * @property {number=} length
 * @property {number=} control1
 *
 * @typedef {object} RadioGpioOptions
 * @property {GdoSignal | number=} gdo0
 * @property {GdoSignal | number=} gdo1
 * @property {GdoSignal | number=} gdo2
 *
 * @typedef {object} RadioConfigOptions
 * @property {Band=} band
 * @property {Modulation=} modulation
 * @property {RadioMode=} mode
 * @property {RadioGpioOptions=} gpio
 * @property {RadioPacketOptions=} packet
 * @property {number=} agcCtrl2
 * @property {Record<string, number>=} registers
 *
 * @typedef {object} DriverRadioConfig
 * @property {RegisterMap} preset
 * @property {Record<string, number>} registers
 */

/** @type {{ MHZ_433: Band, MHZ_868: Band, MHZ_915: Band }} */
const BAND = {
  MHZ_433: "433",
  MHZ_868: "868",
  MHZ_915: "915",
};

/** @type {{ OOK: Modulation, FSK: Modulation }} */
const MODULATION = {
  OOK: "ook",
  FSK: "fsk",
};

/** @type {{ PACKET: RadioMode, DIRECT_ASYNC: RadioMode }} */
const RADIO_MODE = {
  PACKET: "packet",
  DIRECT_ASYNC: "direct_async",
};

/** @type {{ CHIP_READY_N: GdoSignal, HIGH_IMPEDANCE: GdoSignal, PQI: GdoSignal, ASYNC_SERIAL_DATA: GdoSignal }} */
const GDO_SIGNAL = {
  CHIP_READY_N: "chip_ready_n",
  HIGH_IMPEDANCE: "high_impedance",
  PQI: "pqi",
  ASYNC_SERIAL_DATA: "async_serial_data",
};

/** @type {{ FIXED: PacketLengthMode, VARIABLE: PacketLengthMode }} */
const PACKET_LENGTH_MODE = {
  FIXED: "fixed",
  VARIABLE: "variable",
};

/**
 * @param {string} name
 * @param {string} value
 * @param {string[]} allowedValues
 * @returns {void}
 */
function assertEnumValue(name, value, allowedValues) {
  if (!allowedValues.includes(value)) {
    throw new Error(`${name} must be one of: ${allowedValues.join(", ")}`);
  }
}

/**
 * @param {string} name
 * @param {number} value
 * @returns {void}
 */
function assertByte(name, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`${name} must be an integer between 0 and 255`);
  }
}

/**
 * @param {string} name
 * @param {number} value
 * @returns {void}
 */
function assertPacketLength(name, value) {
  if (!Number.isInteger(value) || value < 1 || value > 255) {
    throw new Error(`${name} must be an integer between 1 and 255`);
  }
}

/**
 * @param {number} freqMHz
 * @returns {RegisterMap}
 */
function getFrequencyRegisters(freqMHz) {
  // CC1101 frequency word:
  // FREQ = freq_hz / (26e6 / 2^16)
  const crystalHz = 26_000_000;
  const freqHz = Number(freqMHz) * 1_000_000;
  const word = Math.round(freqHz / (crystalHz / 65536));

  return {
    [REG.FREQ2]: (word >> 16) & 0xff,
    [REG.FREQ1]: (word >> 8) & 0xff,
    [REG.FREQ0]: word & 0xff,
  };
}

/**
 * @param {{ band?: Band }=} options
 * @returns {RegisterMap}
 */
function getCommonPreset({ band = BAND.MHZ_433 } = {}) {
  const freqMap = {
    [BAND.MHZ_433]: 433.92,
    [BAND.MHZ_868]: 868.3,
    [BAND.MHZ_915]: 915.0,
  };

  const freqRegs = getFrequencyRegisters(freqMap[band] ?? 433.92);

  const common = {
    [REG.IOCFG2]: VALUE.IOCFG.CHIP_READY_N,
    [REG.IOCFG1]: VALUE.IOCFG.HIGH_IMPEDANCE,
    [REG.IOCFG0]: 0x06,
    [REG.FIFOTHR]: 0x47,
    [REG.SYNC1]: 0xd3,
    [REG.SYNC0]: 0x91,
    [REG.PKTLEN]: 0x3d,
    [REG.PKTCTRL1]: VALUE.PKTCTRL1.APPEND_STATUS,
    [REG.PKTCTRL0]: VALUE.PKTCTRL0.VARIABLE_LENGTH_WITH_CRC,
    [REG.FSCTRL1]: 0x06,
    [REG.FSCTRL0]: 0x00,
    [REG.MCSM2]: 0x07,
    [REG.MCSM1]: 0x30,
    [REG.MCSM0]: 0x18,
    [REG.FOCCFG]: 0x16,
    [REG.BSCFG]: 0x6c,
    [REG.AGCCTRL2]: VALUE.AGCCTRL2.DEFAULT,
    [REG.AGCCTRL1]: 0x40,
    [REG.AGCCTRL0]: 0x91,
    [REG.FREND1]: 0x56,
    [REG.FREND0]: 0x10,
    [REG.FSCAL3]: 0xe9,
    [REG.FSCAL2]: 0x2a,
    [REG.FSCAL1]: 0x00,
    [REG.FSCAL0]: 0x1f,
    [REG.TEST2]: 0x81,
    [REG.TEST1]: 0x35,
    [REG.TEST0]: 0x09,
    ...freqRegs,
  };

  return common;
}

/**
 * @param {{ band?: Band, modulation?: Modulation }=} options
 * @returns {RegisterMap}
 */
function getPacketPreset({
  band = BAND.MHZ_433,
  modulation = MODULATION.OOK,
} = {}) {
  const common = getCommonPreset({ band });

  if (modulation === MODULATION.FSK) {
    return {
      ...common,
      [REG.MDMCFG4]: 0xca,
      [REG.MDMCFG3]: 0x83,
      [REG.MDMCFG2]: VALUE.MDMCFG2.FSK_PACKET,
      [REG.MDMCFG1]: 0x22,
      [REG.MDMCFG0]: 0xf8,
      [REG.DEVIATN]: 0x15,
    };
  }

  return {
    ...common,
    [REG.MDMCFG4]: 0xf5,
    [REG.MDMCFG3]: 0x43,
    [REG.MDMCFG2]: VALUE.MDMCFG2.OOK_NO_SYNC,
    [REG.MDMCFG1]: 0x22,
    [REG.MDMCFG0]: 0xf8,
    [REG.DEVIATN]: 0x00,
  };
}

/**
 * @param {{
 *   band?: Band,
 *   modulation?: Modulation,
 *   packetControl1?: number,
 *   gdo0?: number,
 *   gdo1?: number,
 *   gdo2?: number,
 *   agcCtrl2?: number
 * }=} options
 * @returns {RegisterMap}
 */
function getDirectAsyncPreset({
  band = BAND.MHZ_433,
  modulation = MODULATION.OOK,
  packetControl1 = VALUE.PKTCTRL1.NO_ADDRESS_CHECK,
  gdo0 = VALUE.IOCFG.ASYNC_SERIAL_DATA,
  gdo2 = VALUE.IOCFG.HIGH_IMPEDANCE,
  gdo1 = VALUE.IOCFG.HIGH_IMPEDANCE,
  agcCtrl2 = VALUE.AGCCTRL2.MAX_DVGA_GAIN,
} = {}) {
  const common = getCommonPreset({ band });

  if (modulation !== MODULATION.OOK) {
    throw new Error(`Direct async mode is only supported for ${MODULATION.OOK}`);
  }

  return {
    ...common,
    [REG.MDMCFG4]: 0xf5,   // wider bandwidth
    [REG.MDMCFG3]: 0x43,
    [REG.MDMCFG2]: VALUE.MDMCFG2.OOK_NO_SYNC,   // NO strict sync (important)
    [REG.MDMCFG1]: 0x22,
    [REG.MDMCFG0]: 0xf8,
    [REG.DEVIATN]: 0x00,

    [REG.PKTCTRL1]: packetControl1,
    [REG.PKTCTRL0]: VALUE.PKTCTRL0.VARIABLE_LENGTH_WITH_CRC,
    [REG.PKTLEN]: 0x3d,

    [REG.IOCFG0]: gdo0,
    [REG.IOCFG1]: gdo1,
    [REG.IOCFG2]: gdo2,
    [REG.PKTCTRL0]: VALUE.PKTCTRL0.ASYNC_SERIAL_MODE,
    [REG.MDMCFG2]: VALUE.MDMCFG2.OOK_NO_SYNC,

    [REG.AGCCTRL2]: agcCtrl2,
  };
}

/**
 * @param {Parameters<typeof getDirectAsyncPreset>[0]=} options
 * @returns {RegisterMap}
 */
function getDirectAsyncReceivePreset(options = {}) {
  return getDirectAsyncPreset(options);
}

/**
 * @param {Parameters<typeof getDirectAsyncPreset>[0]=} options
 * @returns {RegisterMap}
 */
function getDirectAsyncTransmitPreset(options = {}) {
  return getDirectAsyncPreset(options);
}

/**
 * @param {RadioConfigOptions=} options
 * @returns {RegisterMap}
 */
function getBasePreset(options = {}) {
  const mode = options.mode ?? RADIO_MODE.PACKET;

  if (mode === RADIO_MODE.DIRECT_ASYNC) {
    return getDirectAsyncPreset(options);
  }

  return getPacketPreset(options);
}

/**
 * @param {GdoSignal | number | undefined} signal
 * @param {GdoSignal} fallback
 * @returns {number}
 */
function resolveGdoSignal(signal, fallback) {
  const normalized = signal ?? fallback;

  const signalMap = {
    [GDO_SIGNAL.CHIP_READY_N]: VALUE.IOCFG.CHIP_READY_N,
    [GDO_SIGNAL.HIGH_IMPEDANCE]: VALUE.IOCFG.HIGH_IMPEDANCE,
    [GDO_SIGNAL.PQI]: VALUE.IOCFG.PQI,
    [GDO_SIGNAL.ASYNC_SERIAL_DATA]: VALUE.IOCFG.ASYNC_SERIAL_DATA,
  };

  if (typeof normalized === "number") {
    return normalized;
  }

  if (!(normalized in signalMap)) {
    throw new Error(`Unsupported GDO signal: ${normalized}`);
  }

  return signalMap[normalized];
}

/**
 * @param {RadioConfigOptions=} options
 * @returns {void}
 */
function validateRadioConfig(options = {}) {
  const {
    band = BAND.MHZ_433,
    modulation = MODULATION.OOK,
    mode = RADIO_MODE.PACKET,
    gpio = {},
    packet = {},
    registers,
    agcCtrl2,
  } = options;

  assertEnumValue("band", band, Object.values(BAND));
  assertEnumValue("modulation", modulation, Object.values(MODULATION));
  assertEnumValue("mode", mode, Object.values(RADIO_MODE));

  if (mode === RADIO_MODE.DIRECT_ASYNC && modulation !== MODULATION.OOK) {
    throw new Error(`mode=${RADIO_MODE.DIRECT_ASYNC} only supports modulation=${MODULATION.OOK}`);
  }

  if (gpio === null || typeof gpio !== "object" || Array.isArray(gpio)) {
    throw new Error("gpio must be an object");
  }

  if (packet === null || typeof packet !== "object" || Array.isArray(packet)) {
    throw new Error("packet must be an object");
  }

  if (packet.lengthMode !== undefined) {
    assertEnumValue("packet.lengthMode", packet.lengthMode, Object.values(PACKET_LENGTH_MODE));
  }

  if (packet.appendStatus !== undefined && typeof packet.appendStatus !== "boolean") {
    throw new Error("packet.appendStatus must be a boolean");
  }

  if (packet.length !== undefined) {
    assertPacketLength("packet.length", Number(packet.length));
  }

  if (packet.control1 !== undefined) {
    assertByte("packet.control1", Number(packet.control1));
  }

  if (agcCtrl2 !== undefined) {
    assertByte("agcCtrl2", Number(agcCtrl2));
  }

  if (mode === RADIO_MODE.DIRECT_ASYNC) {
    if (packet.length !== undefined) {
      throw new Error("packet.length is not used in direct_async mode");
    }

    if (packet.lengthMode !== undefined) {
      throw new Error("packet.lengthMode is not supported in direct_async mode");
    }
  }

  for (const [pinName, signal] of Object.entries(gpio)) {
    if (!["gdo0", "gdo1", "gdo2"].includes(pinName)) {
      throw new Error(`Unsupported gpio field: ${pinName}`);
    }

    resolveGdoSignal(signal, GDO_SIGNAL.HIGH_IMPEDANCE);
  }

  if (mode === RADIO_MODE.PACKET) {
    const asyncSignals = [gpio.gdo0, gpio.gdo1, gpio.gdo2].filter(
      (signal) => signal === GDO_SIGNAL.ASYNC_SERIAL_DATA
    );

    if (asyncSignals.length > 0) {
      throw new Error("async_serial_data GDO routing is only valid in direct_async mode");
    }
  }

  if (registers !== undefined && (registers === null || typeof registers !== "object" || Array.isArray(registers))) {
    throw new Error("registers must be an object");
  }
}

/**
 * @param {RadioConfigOptions=} options
 * @returns {DriverRadioConfig}
 */
function buildRadioConfig(options = {}) {
  validateRadioConfig(options);

  const {
    band = BAND.MHZ_433,
    modulation = MODULATION.OOK,
    mode = RADIO_MODE.PACKET,
    gpio = {},
    packet = {},
  } = options;

  let preset;

  if (mode === RADIO_MODE.DIRECT_ASYNC) {
    preset = getDirectAsyncPreset({
      band,
      modulation,
      packetControl1: packet.control1 ?? (
        packet.appendStatus ? VALUE.PKTCTRL1.APPEND_STATUS : VALUE.PKTCTRL1.NO_ADDRESS_CHECK
      ),
      gdo0: resolveGdoSignal(gpio.gdo0, GDO_SIGNAL.ASYNC_SERIAL_DATA),
      gdo1: resolveGdoSignal(gpio.gdo1, GDO_SIGNAL.HIGH_IMPEDANCE),
      gdo2: resolveGdoSignal(gpio.gdo2, GDO_SIGNAL.HIGH_IMPEDANCE),
      agcCtrl2: options.agcCtrl2,
    });
  } else {
    preset = getPacketPreset({ band, modulation });
  }

  /** @type {Record<string, number>} */
  const registers = {};

  if (mode === RADIO_MODE.PACKET) {
    if (packet.length !== undefined) {
      registers.PKTLEN = Number(packet.length);
    }

    if (packet.lengthMode === PACKET_LENGTH_MODE.FIXED) {
      registers.PKTCTRL0 = VALUE.PKTCTRL0.FIXED_LENGTH;
    } else if (packet.lengthMode === PACKET_LENGTH_MODE.VARIABLE) {
      registers.PKTCTRL0 = VALUE.PKTCTRL0.VARIABLE_LENGTH_WITH_CRC;
    }

    if (packet.appendStatus === false) {
      registers.PKTCTRL1 = VALUE.PKTCTRL1.NO_ADDRESS_CHECK;
    } else if (packet.appendStatus === true) {
      registers.PKTCTRL1 = VALUE.PKTCTRL1.APPEND_STATUS;
    }

    if (gpio.gdo0 !== undefined) {
      registers.IOCFG0 = resolveGdoSignal(gpio.gdo0, GDO_SIGNAL.ASYNC_SERIAL_DATA);
    }

    if (gpio.gdo1 !== undefined) {
      registers.IOCFG1 = resolveGdoSignal(gpio.gdo1, GDO_SIGNAL.HIGH_IMPEDANCE);
    }

    if (gpio.gdo2 !== undefined) {
      registers.IOCFG2 = resolveGdoSignal(gpio.gdo2, GDO_SIGNAL.CHIP_READY_N);
    }
  }

  if (options.registers) {
    Object.assign(registers, options.registers);
  }

  return {
    preset,
    registers,
  };
}

module.exports = {
  BAND,
  MODULATION,
  RADIO_MODE,
  GDO_SIGNAL,
  PACKET_LENGTH_MODE,
  getBasePreset,
  getCommonPreset,
  getPacketPreset,
  getDirectAsyncPreset,
  getDirectAsyncReceivePreset,
  getDirectAsyncTransmitPreset,
  getFrequencyRegisters,
  validateRadioConfig,
  buildRadioConfig,
};
