// @ts-check

/**
 * @typedef {Record<string, number>} NumericMap
 *
 * @typedef {object} Cc1101ValueMap
 * @property {NumericMap} IOCFG
 * @property {NumericMap} PKTCTRL0
 * @property {NumericMap} PKTCTRL1
 * @property {NumericMap} MDMCFG2
 * @property {NumericMap} AGCCTRL2
 */

// CC1101 command strobes
/** @type {NumericMap} */
const STROBE = {
  SRES: 0x30,
  SFSTXON: 0x31,
  SXOFF: 0x32,
  SCAL: 0x33,
  SRX: 0x34,
  STX: 0x35,
  SIDLE: 0x36,
  SAFC: 0x37,
  SWOR: 0x38,
  SPWD: 0x39,
  SFRX: 0x3a,
  SFTX: 0x3b,
  SWORRST: 0x3c,
  SNOP: 0x3d,
};

// CC1101 config registers
/** @type {NumericMap} */
const REG = {
  IOCFG2: 0x00,
  IOCFG1: 0x01,
  IOCFG0: 0x02,
  FIFOTHR: 0x03,
  SYNC1: 0x04,
  SYNC0: 0x05,
  PKTLEN: 0x06,
  PKTCTRL1: 0x07,
  PKTCTRL0: 0x08,
  ADDR: 0x09,
  CHANNR: 0x0a,
  FSCTRL1: 0x0b,
  FSCTRL0: 0x0c,
  FREQ2: 0x0d,
  FREQ1: 0x0e,
  FREQ0: 0x0f,
  MDMCFG4: 0x10,
  MDMCFG3: 0x11,
  MDMCFG2: 0x12,
  MDMCFG1: 0x13,
  MDMCFG0: 0x14,
  DEVIATN: 0x15,
  MCSM2: 0x16,
  MCSM1: 0x17,
  MCSM0: 0x18,
  FOCCFG: 0x19,
  BSCFG: 0x1a,
  AGCCTRL2: 0x1b,
  AGCCTRL1: 0x1c,
  AGCCTRL0: 0x1d,
  WOREVT1: 0x1e,
  WOREVT0: 0x1f,
  WORCTRL: 0x20,
  FREND1: 0x21,
  FREND0: 0x22,
  FSCAL3: 0x23,
  FSCAL2: 0x24,
  FSCAL1: 0x25,
  FSCAL0: 0x26,
  RCCTRL1: 0x27,
  RCCTRL0: 0x28,
  FSTEST: 0x29,
  PTEST: 0x2a,
  AGCTEST: 0x2b,
  TEST2: 0x2c,
  TEST1: 0x2d,
  TEST0: 0x2e,
};

// CC1101 status registers
/** @type {NumericMap} */
const STATUS = {
  PARTNUM: 0x30,
  VERSION: 0x31,
  FREQEST: 0x32,
  LQI: 0x33,
  RSSI: 0x34,
  MARCSTATE: 0x35,
  WORTIME1: 0x36,
  WORTIME0: 0x37,
  PKTSTATUS: 0x38,
  VCO_VC_DAC: 0x39,
  TXBYTES: 0x3a,
  RXBYTES: 0x3b,
  RCCTRL1_STATUS: 0x3c,
  RCCTRL0_STATUS: 0x3d,
};

/** @type {NumericMap} */
const FIFO = {
  TX: 0x3f,
  RX: 0x3f,
};

/** @type {NumericMap} */
const ACCESS = {
  WRITE_BURST: 0x40,
  READ_SINGLE: 0x80,
  READ_BURST: 0xc0,
};

/**
 * @typedef {object} DriverDefaults
 * @property {number} BUS
 * @property {number} DEVICE
 * @property {number} SPEED_HZ
 * @property {number} MODE
 */

/** @type {DriverDefaults} */
const DEFAULTS = {
  BUS: 0,
  DEVICE: 0,
  SPEED_HZ: 500_000,
  MODE: 0,
};

/** @type {Cc1101ValueMap} */
const VALUE = {
  IOCFG: {
    HIGH_IMPEDANCE: 0x2e,
    CHIP_READY_N: 0x29,
    PQI: 0x08,
    ASYNC_SERIAL_DATA: 0x0d,
  },
  PKTCTRL0: {
    FIXED_LENGTH: 0x00,
    VARIABLE_LENGTH: 0x01,
    VARIABLE_LENGTH_WITH_CRC: 0x05,
    ASYNC_SERIAL_MODE: 0x32,
  },
  PKTCTRL1: {
    NO_ADDRESS_CHECK: 0x00,
    ADDRESS_CHECK_NO_BROADCAST: 0x01,
    ADDRESS_CHECK_0_BROADCAST: 0x02,
    ADDRESS_CHECK_0_255_BROADCAST: 0x03,
    APPEND_STATUS: 0x04,
    PQT_1: 0x20,
  },
  MDMCFG2: {
    TWO_FSK_PACKET: 0x02,
    GFSK_PACKET: 0x12,
    FSK_PACKET: 0x12,
    MSK_PACKET: 0x72,
    OOK_NO_SYNC: 0x30,
  },
  AGCCTRL2: {
    DEFAULT: 0x43,
    MAX_DVGA_GAIN: 0x03,
  },
};


module.exports = {
  STROBE,
  REG,
  STATUS,
  FIFO,
  ACCESS,
  DEFAULTS,
  VALUE,
};
