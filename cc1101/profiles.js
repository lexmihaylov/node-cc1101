// @ts-check

const { REG, VALUE } = require("./constants");

/**
 * @typedef {"315" | "433" | "868" | "915"} Band
 * @typedef {"ook" | "fsk" | "2fsk" | "gfsk" | "msk"} Modulation
 * @typedef {"packet" | "direct_async"} RadioMode
 * @typedef {"chip_ready_n" | "high_impedance" | "pqi" | "async_serial_data"} GdoSignal
 * @typedef {"fixed" | "variable"} PacketLengthMode
 * @typedef {"none" | "address" | "address_0_broadcast" | "address_0_255_broadcast"} PacketAddressCheck
 * @typedef {Record<number, number>} RegisterMap
 *
 * @typedef {object} RadioPacketOptions
 * @property {boolean=} appendStatus
 * @property {PacketLengthMode=} lengthMode
 * @property {number=} length
 * @property {number=} control1
 * @property {boolean=} crc
 * @property {boolean=} whitening
 * @property {boolean=} fec
 * @property {PacketAddressCheck=} addressCheck
 * @property {number=} address
 * @property {number=} syncMode
 * @property {number | [number, number]=} syncWord
 * @property {2 | 3 | 4 | 6 | 8 | 12 | 16 | 24=} preambleBytes
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

/** @type {{ MHZ_315: Band, MHZ_433: Band, MHZ_868: Band, MHZ_915: Band }} */
const BAND = {
  MHZ_315: "315",
  MHZ_433: "433",
  MHZ_868: "868",
  MHZ_915: "915",
};

/** @type {{ OOK: Modulation, FSK: Modulation, TWO_FSK: Modulation, GFSK: Modulation, MSK: Modulation }} */
const MODULATION = {
  OOK: "ook",
  FSK: "fsk",
  TWO_FSK: "2fsk",
  GFSK: "gfsk",
  MSK: "msk",
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

/** @type {{ NONE: PacketAddressCheck, ADDRESS: PacketAddressCheck, ADDRESS_0_BROADCAST: PacketAddressCheck, ADDRESS_0_255_BROADCAST: PacketAddressCheck }} */
const PACKET_ADDRESS_CHECK = {
  NONE: "none",
  ADDRESS: "address",
  ADDRESS_0_BROADCAST: "address_0_broadcast",
  ADDRESS_0_255_BROADCAST: "address_0_255_broadcast",
};

/** @type {{ NONE: number, SYNC_15_16: number, SYNC_16_16: number, SYNC_30_32: number, CARRIER: number, CARRIER_SYNC_15_16: number, CARRIER_SYNC_16_16: number, CARRIER_SYNC_30_32: number }} */
const PACKET_SYNC_MODE = {
  NONE: 0x00,
  SYNC_15_16: 0x01,
  SYNC_16_16: 0x02,
  SYNC_30_32: 0x03,
  CARRIER: 0x04,
  CARRIER_SYNC_15_16: 0x05,
  CARRIER_SYNC_16_16: 0x06,
  CARRIER_SYNC_30_32: 0x07,
};

/** @type {{ BYTES_2: 2, BYTES_3: 3, BYTES_4: 4, BYTES_6: 6, BYTES_8: 8, BYTES_12: 12, BYTES_16: 16, BYTES_24: 24 }} */
const PREAMBLE_BYTES = {
  BYTES_2: 2,
  BYTES_3: 3,
  BYTES_4: 4,
  BYTES_6: 6,
  BYTES_8: 8,
  BYTES_12: 12,
  BYTES_16: 16,
  BYTES_24: 24,
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
 * @param {string} name
 * @param {number} value
 * @returns {void}
 */
function assertSyncMode(name, value) {
  if (!Number.isInteger(value) || value < 0 || value > 7) {
    throw new Error(`${name} must be an integer between 0 and 7`);
  }
}

/**
 * @param {string} name
 * @param {number} value
 * @returns {void}
 */
function assertSyncWord(name, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`${name} must be an integer between 0 and 65535`);
  }
}

/**
 * @param {number} bytes
 * @returns {number}
 */
function resolvePreambleCode(bytes) {
  const mapping = {
    2: 0,
    3: 1,
    4: 2,
    6: 3,
    8: 4,
    12: 5,
    16: 6,
    24: 7,
  };

  if (!(bytes in mapping)) {
    throw new Error(`Unsupported preambleBytes: ${bytes}`);
  }

  return mapping[bytes];
}

/**
 * @param {PacketAddressCheck | undefined} mode
 * @returns {number}
 */
function resolveAddressCheck(mode) {
  const mapping = {
    [PACKET_ADDRESS_CHECK.NONE]: VALUE.PKTCTRL1.NO_ADDRESS_CHECK,
    [PACKET_ADDRESS_CHECK.ADDRESS]: VALUE.PKTCTRL1.ADDRESS_CHECK_NO_BROADCAST,
    [PACKET_ADDRESS_CHECK.ADDRESS_0_BROADCAST]: VALUE.PKTCTRL1.ADDRESS_CHECK_0_BROADCAST,
    [PACKET_ADDRESS_CHECK.ADDRESS_0_255_BROADCAST]: VALUE.PKTCTRL1.ADDRESS_CHECK_0_255_BROADCAST,
  };

  return mapping[mode ?? PACKET_ADDRESS_CHECK.NONE];
}

/**
 * @param {Modulation} modulation
 * @returns {number}
 */
function resolvePacketModulationBits(modulation) {
  if (modulation === MODULATION.FSK || modulation === MODULATION.GFSK) return 0x10;
  if (modulation === MODULATION.TWO_FSK) return 0x00;
  if (modulation === MODULATION.MSK) return 0x70;
  if (modulation === MODULATION.OOK) return 0x30;
  throw new Error(`Unsupported modulation: ${modulation}`);
}

/**
 * @param {Modulation} modulation
 * @returns {number}
 */
function getDefaultPacketSyncMode(modulation) {
  return modulation === MODULATION.OOK ? PACKET_SYNC_MODE.NONE : PACKET_SYNC_MODE.SYNC_16_16;
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
    [BAND.MHZ_315]: 315.0,
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

  if (modulation === MODULATION.FSK || modulation === MODULATION.GFSK) {
    return {
      ...common,
      [REG.MDMCFG4]: 0xca,
      [REG.MDMCFG3]: 0x83,
      [REG.MDMCFG2]: VALUE.MDMCFG2.GFSK_PACKET,
      [REG.MDMCFG1]: 0x22,
      [REG.MDMCFG0]: 0xf8,
      [REG.DEVIATN]: 0x15,
    };
  }

  if (modulation === MODULATION.TWO_FSK) {
    return {
      ...common,
      [REG.MDMCFG4]: 0xca,
      [REG.MDMCFG3]: 0x83,
      [REG.MDMCFG2]: VALUE.MDMCFG2.TWO_FSK_PACKET,
      [REG.MDMCFG1]: 0x22,
      [REG.MDMCFG0]: 0xf8,
      [REG.DEVIATN]: 0x15,
    };
  }

  if (modulation === MODULATION.MSK) {
    return {
      ...common,
      [REG.MDMCFG4]: 0xca,
      [REG.MDMCFG3]: 0x83,
      [REG.MDMCFG2]: VALUE.MDMCFG2.MSK_PACKET,
      [REG.MDMCFG1]: 0x22,
      [REG.MDMCFG0]: 0xf8,
      [REG.DEVIATN]: 0x00,
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
  gdo2 = VALUE.IOCFG.PQI,
  gdo1 = VALUE.IOCFG.HIGH_IMPEDANCE,
  agcCtrl2 = VALUE.AGCCTRL2.MAX_DVGA_GAIN,
} = {}) {
  const common = getCommonPreset({ band });

  if (modulation !== MODULATION.OOK) {
    throw new Error(`Direct async mode is only supported for ${MODULATION.OOK}`);
  }

  return {
    ...common,
    [REG.MDMCFG4]: 0xf5,
    [REG.MDMCFG3]: 0x43,
    [REG.MDMCFG2]: VALUE.MDMCFG2.OOK_NO_SYNC,
    [REG.MDMCFG1]: 0x22,
    [REG.MDMCFG0]: 0xf8,
    [REG.DEVIATN]: 0x00,
    [REG.PKTCTRL1]: packetControl1,
    [REG.PKTLEN]: 0x3d,
    [REG.IOCFG0]: gdo0,
    [REG.IOCFG1]: gdo1,
    [REG.IOCFG2]: gdo2,
    [REG.PKTCTRL0]: VALUE.PKTCTRL0.ASYNC_SERIAL_MODE,
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

  if (packet.crc !== undefined && typeof packet.crc !== "boolean") {
    throw new Error("packet.crc must be a boolean");
  }

  if (packet.whitening !== undefined && typeof packet.whitening !== "boolean") {
    throw new Error("packet.whitening must be a boolean");
  }

  if (packet.fec !== undefined && typeof packet.fec !== "boolean") {
    throw new Error("packet.fec must be a boolean");
  }

  if (packet.addressCheck !== undefined) {
    assertEnumValue("packet.addressCheck", packet.addressCheck, Object.values(PACKET_ADDRESS_CHECK));
  }

  if (packet.address !== undefined) {
    assertByte("packet.address", Number(packet.address));
  }

  if (packet.syncMode !== undefined) {
    assertSyncMode("packet.syncMode", Number(packet.syncMode));
  }

  if (packet.syncWord !== undefined) {
    if (Array.isArray(packet.syncWord)) {
      if (packet.syncWord.length !== 2) {
        throw new Error("packet.syncWord array must have exactly two bytes");
      }
      assertByte("packet.syncWord[0]", Number(packet.syncWord[0]));
      assertByte("packet.syncWord[1]", Number(packet.syncWord[1]));
    } else {
      assertSyncWord("packet.syncWord", Number(packet.syncWord));
    }
  }

  if (packet.preambleBytes !== undefined) {
    resolvePreambleCode(Number(packet.preambleBytes));
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

    if (packet.crc !== undefined) {
      throw new Error("packet.crc is not supported in direct_async mode");
    }

    if (packet.whitening !== undefined) {
      throw new Error("packet.whitening is not supported in direct_async mode");
    }

    if (packet.fec !== undefined) {
      throw new Error("packet.fec is not supported in direct_async mode");
    }

    if (packet.addressCheck !== undefined) {
      throw new Error("packet.addressCheck is not supported in direct_async mode");
    }

    if (packet.address !== undefined) {
      throw new Error("packet.address is not used in direct_async mode");
    }

    if (packet.syncMode !== undefined) {
      throw new Error("packet.syncMode is not supported in direct_async mode");
    }

    if (packet.syncWord !== undefined) {
      throw new Error("packet.syncWord is not supported in direct_async mode");
    }

    if (packet.preambleBytes !== undefined) {
      throw new Error("packet.preambleBytes is not supported in direct_async mode");
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
      gdo2: resolveGdoSignal(gpio.gdo2, GDO_SIGNAL.PQI),
      agcCtrl2: options.agcCtrl2,
    });
  } else {
    preset = getPacketPreset({ band, modulation });
  }

  /** @type {Record<string, number>} */
  const registers = {};

  if (mode === RADIO_MODE.PACKET) {
    const crcEnabled = packet.crc ?? true;
    const whiteningEnabled = packet.whitening ?? false;
    const lengthMode = packet.lengthMode ?? PACKET_LENGTH_MODE.VARIABLE;
    const appendStatus = packet.appendStatus ?? true;
    const syncMode = packet.syncMode ?? getDefaultPacketSyncMode(modulation);
    const preambleCode = resolvePreambleCode(Number(packet.preambleBytes ?? PREAMBLE_BYTES.BYTES_4));

    if (packet.length !== undefined) {
      registers.PKTLEN = Number(packet.length);
    }

    const lengthBits = lengthMode === PACKET_LENGTH_MODE.FIXED
      ? VALUE.PKTCTRL0.FIXED_LENGTH
      : VALUE.PKTCTRL0.VARIABLE_LENGTH;
    registers.PKTCTRL0 = (whiteningEnabled ? 0x40 : 0x00) | (crcEnabled ? 0x04 : 0x00) | lengthBits;
    registers.PKTCTRL1 = (appendStatus ? VALUE.PKTCTRL1.APPEND_STATUS : 0x00) | resolveAddressCheck(packet.addressCheck);

    const lowMdmcfg1Bits = preset[REG.MDMCFG1] & 0x0f;
    registers.MDMCFG1 = lowMdmcfg1Bits | (packet.fec ? 0x80 : 0x00) | (preambleCode << 4);
    registers.MDMCFG2 = resolvePacketModulationBits(modulation) | syncMode;

    if (packet.address !== undefined) {
      registers.ADDR = Number(packet.address);
    }

    if (packet.syncWord !== undefined) {
      if (Array.isArray(packet.syncWord)) {
        registers.SYNC1 = Number(packet.syncWord[0]);
        registers.SYNC0 = Number(packet.syncWord[1]);
      } else {
        const word = Number(packet.syncWord);
        registers.SYNC1 = (word >> 8) & 0xff;
        registers.SYNC0 = word & 0xff;
      }
    }

    if (packet.control1 !== undefined) {
      registers.PKTCTRL1 = Number(packet.control1);
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
  PACKET_ADDRESS_CHECK,
  PACKET_SYNC_MODE,
  PREAMBLE_BYTES,
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
