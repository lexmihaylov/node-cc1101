// @ts-check

const { BAND, GDO_SIGNAL, MODULATION, RADIO_MODE } = require("./cc1101/profiles");

module.exports = {
  spi: {
    bus: 0,
    device: 0,
    speedHz: 100000,
  },
  radio: {
    band: BAND.MHZ_433,
    modulation: MODULATION.OOK,
    mode: RADIO_MODE.PACKET,
  },
  directAsync: {
    rx: {
      gpio: 25,
      silenceGapUs: 10000,
      bitUnitUs: undefined,
      radio: {
        gdo0: GDO_SIGNAL.HIGH_IMPEDANCE,
        gdo2: GDO_SIGNAL.ASYNC_SERIAL_DATA,
      },
    },
    tx: {
      gpio: 24,
      repeats: 10,
      repeatGapUs: 10000,
      invert: false,
      radio: {
        gdo0: GDO_SIGNAL.ASYNC_SERIAL_DATA,
        gdo2: GDO_SIGNAL.HIGH_IMPEDANCE,
      },
    },
    filter: {
      minimumPulseWidthUs: 150,
    },
    preview: {
      intervalMs: 120,
      edgeWindow: 16,
      windowMs: 2400,
      sampleMs: 25,
    },
  },
};
