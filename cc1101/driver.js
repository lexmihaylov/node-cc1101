// @ts-check

const spi = require("spi-device");
const { ACCESS, DEFAULTS, FIFO, REG, STATUS, STROBE } = require("./constants.js");
const { buildRadioConfig, RADIO_MODE } = require("./profiles.js");

/**
 * @typedef {import("./profiles.js").RadioConfigOptions} RadioConfigOptions
 * @typedef {import("./profiles.js").DriverRadioConfig} DriverRadioConfig
 * @typedef {Record<number, number>} RegisterMap
 *
 * @typedef {object} DriverOptions
 * @property {number=} bus
 * @property {number=} device
 * @property {number=} speedHz
 * @property {number=} mode
 *
 * @typedef {object} ChipInfo
 * @property {number} partnum
 * @property {number} version
 * @property {number} marcstate
 * @property {number} rxbytes
 * @property {boolean} rxOverflow
 *
 * @typedef {object} RxPacket
 * @property {number} length
 * @property {number[]} payload
 * @property {number[]} status
 *
 * @typedef {object} ReadFifoPacketResult
 * @property {boolean} overflow
 * @property {RxPacket | null} packet
 * @property {number=} invalidLength
 */

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CC1101Driver {
  /**
   * @param {DriverOptions=} options
   */
  constructor(options = {}) {
    this.bus = options.bus ?? DEFAULTS.BUS;
    this.device = options.device ?? DEFAULTS.DEVICE;
    this.speedHz = options.speedHz ?? DEFAULTS.SPEED_HZ;
    this.mode = options.mode ?? DEFAULTS.MODE;
    this.dev = null;
  }

  /**
   * @param {number} address
   * @param {number} accessMode
   * @returns {Promise<number[]>}
   */
  async debugRead(address, accessMode) {
    return await this.transfer([address | accessMode, 0x00, 0x00]);
  }

  /** @returns {Promise<void>} */
  async open() {
    if (this.dev) return;

    this.dev = await new Promise((resolve, reject) => {
      const instance = spi.open(this.bus, this.device, { mode: this.mode }, (err) => {
        if (err) return reject(err);
        resolve(instance);
      });
    });
  }

  /** @returns {Promise<void>} */
  async close() {
    if (!this.dev) return;

    await new Promise((resolve, reject) => {
      this.dev.close((err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    this.dev = null;
  }

  /**
   * @param {number[]} sendBytes
   * @returns {Promise<number[]>}
   */
  async transfer(sendBytes) {
    if (!this.dev) {
      throw new Error("SPI device is not open");
    }

    const sendBuffer = Buffer.from(sendBytes);
    const receiveBuffer = Buffer.alloc(sendBuffer.length);

    const message = [
      {
        sendBuffer,
        receiveBuffer,
        byteLength: sendBuffer.length,
        speedHz: this.speedHz,
      },
    ];

    return await new Promise((resolve, reject) => {
      this.dev.transfer(message, (err, messages) => {
        if (err) return reject(err);
        resolve([...messages[0].receiveBuffer]);
      });
    });
  }

  /**
   * @param {number} command
   * @returns {Promise<number>}
   */
  async strobe(command) {
    const rx = await this.transfer([command]);
    return rx[0];
  }

  /**
   * @param {number} address
   * @param {number} value
   * @returns {Promise<void>}
   */
  async writeRegister(address, value) {
    await this.transfer([address, value & 0xff]);
  }

  /**
   * @param {number} address
   * @returns {Promise<number>}
   */
  async readRegister(address) {
    const isStatusRegister = address >= 0x30 && address <= 0x3d;
    const accessMode = isStatusRegister ? ACCESS.READ_BURST : ACCESS.READ_SINGLE;

    const rx = await this.transfer([address | accessMode, 0x00]);
    return rx[1];
  }

  /**
   * @param {number} address
   * @param {number[]} values
   * @returns {Promise<void>}
   */
  async writeBurst(address, values) {
    await this.transfer([address | ACCESS.WRITE_BURST, ...values.map((v) => v & 0xff)]);
  }

  /**
   * @param {number} address
   * @param {number} length
   * @returns {Promise<number[]>}
   */
  async readBurst(address, length) {
    const rx = await this.transfer([address | ACCESS.READ_BURST, ...new Array(length).fill(0x00)]);
    return rx.slice(1);
  }

  /** @returns {Promise<void>} */
  async reset() {
    await this.strobe(STROBE.SRES);
    await sleep(10);
  }

  /** @returns {Promise<void>} */
  async idle() {
    await this.strobe(STROBE.SIDLE);
  }

  /** @returns {Promise<void>} */
  async flushRx() {
    await this.idle();
    await this.strobe(STROBE.SFRX);
  }

  /** @returns {Promise<void>} */
  async flushTx() {
    await this.idle();
    await this.strobe(STROBE.SFTX);
  }

  /** @returns {Promise<void>} */
  async enterRx() {
    await this.strobe(STROBE.SRX);
  }

  /** @returns {Promise<void>} */
  async enterTx() {
    await this.strobe(STROBE.STX);
  }

  /** @returns {Promise<void>} */
  async setFrequency43392() {
    await this.writeRegister(REG.FREQ2, 0x10);
    await this.writeRegister(REG.FREQ1, 0xb0);
    await this.writeRegister(REG.FREQ0, 0x71);
  }

  /** @returns {Promise<ChipInfo>} */
  async getChipInfo() {
    const [partnum, version, marcstate, rxbytes] = await Promise.all([
      this.readRegister(STATUS.PARTNUM),
      this.readRegister(STATUS.VERSION),
      this.readRegister(STATUS.MARCSTATE),
      this.readRegister(STATUS.RXBYTES),
    ]);

    return {
      partnum,
      version,
      marcstate: marcstate & 0x1f,
      rxbytes: rxbytes & 0x7f,
      rxOverflow: Boolean(rxbytes & 0x80),
    };
  }

  /** @returns {Promise<void>} */
  async configureBasicTx() {
    await this.setFrequency43392();
    await this.writeRegister(REG.MDMCFG2, 0x30); // OOK, sync mode
    await this.writeRegister(REG.PKTCTRL0, 0x00); // fixed packet length
    await this.writeRegister(REG.PKTLEN, 0x05);
  }

  /**
   * @param {number[]=} bytes
   * @returns {Promise<void>}
   */
  async sendTestPacket(bytes = [1, 2, 3, 4, 5]) {
    await this.idle();
    await this.flushTx();
    await this.writeBurst(FIFO.TX, bytes);
    await this.enterTx();
  }

  /**
   * @param {RegisterMap} registerMap
   * @returns {Promise<void>}
   */
  async applyRegisters(registerMap) {
    for (const [address, value] of Object.entries(registerMap)) {
      await this.writeRegister(Number(address), value);
    }
  }

  /**
   * @param {{ preset?: RegisterMap, registers?: Record<string, number> } & Record<string, number | RegisterMap | undefined>} config
   * @returns {RegisterMap}
   */
  resolveRegisterMap(config = {}) {
    const reservedKeys = new Set(["preset", "registers"]);
    /** @type {RegisterMap} */
    const registerMap = {};

    if (config.preset) {
      Object.assign(registerMap, config.preset);
    }

    const namedRegisters = {
      ...(config.registers ?? {}),
      ...Object.fromEntries(
        Object.entries(config).filter(([key]) => !reservedKeys.has(key))
      ),
    };

    for (const [key, value] of Object.entries(namedRegisters)) {
      const address = this.resolveRegisterAddress(key);
      registerMap[address] = this.normalizeRegisterValue(key, value);
    }

    return registerMap;
  }

  /**
   * @param {string | number} key
   * @returns {number}
   */
  resolveRegisterAddress(key) {
    if (typeof key === "number") return key;

    if (/^\d+$/.test(key)) {
      return Number(key);
    }

    if (!(key in REG)) {
      throw new Error(`Unknown register name: ${key}`);
    }

    return REG[key];
  }

  /**
   * @param {string | number} key
   * @param {number} value
   * @returns {number}
   */
  normalizeRegisterValue(key, value) {
    const normalized = Number(value);

    if (!Number.isInteger(normalized) || normalized < 0 || normalized > 0xff) {
      throw new Error(`Invalid register value for ${key}: ${value}`);
    }

    return normalized;
  }

  /** @returns {Promise<ChipInfo>} */
  async verifyChip() {
    const info = await this.getChipInfo();

    if (info.partnum !== 0x00) {
      throw new Error(`Unexpected PARTNUM: 0x${info.partnum.toString(16).padStart(2, "0")}`);
    }

    return info;
  }

  /**
   * @param {RegisterMap} registerMap
   * @returns {Promise<void>}
   */
  async configure(registerMap) {
    await this.applyRegisters(registerMap);
  }

  /**
   * @param {{ preset?: RegisterMap, registers?: Record<string, number> } & Record<string, number | RegisterMap | undefined>} config
   * @returns {Promise<void>}
   */
  async configureObject(config = {}) {
    await this.applyRegisters(this.resolveRegisterMap(config));
  }

  /**
   * @param {RadioConfigOptions=} options
   * @returns {Promise<void>}
   */
  async configureRadio(options = {}) {
    await this.configureObject(buildRadioConfig(options));
  }

  /**
   * @param {RadioConfigOptions=} options
   * @returns {Promise<void>}
   */
  async startPacketRx(options = {}) {
    await this.configureRadio({
      ...options,
      mode: RADIO_MODE.PACKET,
    });
    await this.enterRxSafe();
  }

  /**
   * @param {number[]} payload
   * @param {RadioConfigOptions=} options
   * @returns {Promise<void>}
   */
  async transmitPacket(payload, options = {}) {
    await this.configureRadio({
      ...options,
      mode: RADIO_MODE.PACKET,
      packet: {
        ...(options.packet ?? {}),
        length: payload.length,
      },
    });
    await this.sendPacket(payload);
  }

  /**
   * @param {RadioConfigOptions=} options
   * @returns {Promise<void>}
   */
  async startDirectAsyncRx(options = {}) {
    await this.configureRadio({
      ...options,
      mode: RADIO_MODE.DIRECT_ASYNC,
    });
    await this.enterRxSafe();
  }

  /**
   * @param {RadioConfigOptions=} options
   * @returns {Promise<void>}
   */
  async startDirectAsyncTx(options = {}) {
    await this.configureRadio({
      ...options,
      mode: RADIO_MODE.DIRECT_ASYNC,
    });
    await this.idle();
    await this.flushTx();
    await this.enterTx();
  }

  /** @returns {Promise<void>} */
  async enterRxSafe() {
    await this.idle();
    await this.flushRx();
    await this.enterRx();
  }

  /** @returns {Promise<ReadFifoPacketResult>} */
  async readFifoPacket() {
    const info = await this.getChipInfo();

    if (info.rxOverflow) {
      await this.enterRxSafe();
      return { overflow: true, packet: null };
    }

    if (info.rxbytes === 0) {
      return { overflow: false, packet: null };
    }

    const [packetLength] = await this.readBurst(FIFO.RX, 1);

    if (!packetLength || packetLength > 61) {
      await this.enterRxSafe();
      return { overflow: false, packet: null, invalidLength: packetLength };
    }

    const rest = await this.readBurst(FIFO.RX, packetLength + 2);

    return {
      overflow: false,
      packet: {
        length: packetLength,
        payload: rest.slice(0, packetLength),
        status: rest.slice(packetLength, packetLength + 2),
      },
    };
  }

  /**
   * @param {number[]} payload
   * @returns {Promise<void>}
   */
  async sendPacket(payload) {
    await this.idle();
    await this.flushTx();
    await this.writeRegister(REG.PKTCTRL0, 0x00);
    await this.writeRegister(REG.PKTLEN, payload.length);
    await this.writeBurst(FIFO.TX, payload);
    await this.enterTx();
  }
  
  /** @returns {Promise<number>} */
  async getRssi() {
    const raw = await this.readRegister(STATUS.RSSI);
    return raw;
  }
}

module.exports = {CC1101Driver}
