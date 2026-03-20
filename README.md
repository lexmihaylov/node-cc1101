# node-cc1101

Node.js CC1101 library and Raspberry Pi RF toolkit for 433/868/915 MHz over SPI and GPIO.

This project has two parts:

- A reusable CC1101 driver and radio configuration library under [`cc1101/`](/home/lex/projects/node-cc1101/cc1101)
- An interactive shell in [`radio-shell.js`](/home/lex/projects/node-cc1101/radio-shell.js) for listening, analyzing, capturing, and replaying signals

## Features

- SPI driver for CC1101 register access, strobes, FIFO RX/TX, and status reads
- High-level radio configuration with `configureRadio(...)`
- Packet mode helpers for RX/TX
- Direct async mode helpers for raw OOK work
- Signal analysis modules for protocol detection, consensus, burst matching, frame extraction, slicing, and capture/replay
- Interactive shell for RF exploration on Raspberry Pi
- JSDoc types throughout the library for editor completion and TypeScript inference

## Requirements

- Raspberry Pi with SPI enabled
- CC1101 module wired to Raspberry Pi SPI pins
- Node.js 18+
- Native build support required by `pigpio` and `spi-device`

## Install

```bash
npm install
```

Run the shell:

```bash
npm run shell
```

Or:

```bash
node radio-shell.js
```

## Wiring

Minimum SPI wiring:

- `VCC` -> module supply as required by your board
- `GND` -> Pi `GND`
- `SCK` -> Pi `SPI0_SCLK`
- `MOSI` -> Pi `SPI0_MOSI`
- `MISO` -> Pi `SPI0_MISO`
- `CSN` -> Pi `SPI0_CE0` or `SPI0_CE1`

Typical GPIO wiring for direct async / analysis:

- `GDO0` -> a Pi GPIO input, commonly `GPIO24`
- `GDO2` -> a Pi GPIO input, commonly `GPIO25`

The shell defaults assume:

- SPI bus `0`
- SPI device `0`
- `GDO0 = GPIO24`
- `GDO2 = GPIO25`

## Library usage

Import from the package root:

```js
const {
  CC1101Driver,
  BAND,
  MODULATION,
  RADIO_MODE,
  GDO_SIGNAL,
  PACKET_LENGTH_MODE,
} = require("node-cc1101");
```

### Packet RX

```js
const radio = new CC1101Driver({
  bus: 0,
  device: 0,
  speedHz: 100000,
});

await radio.open();
await radio.reset();
await radio.verifyChip();

await radio.startPacketRx({
  band: BAND.MHZ_433,
  modulation: MODULATION.OOK,
  mode: RADIO_MODE.PACKET,
  packet: {
    appendStatus: true,
    lengthMode: PACKET_LENGTH_MODE.VARIABLE,
  },
});

const result = await radio.readFifoPacket();
console.log(result);
```

### Packet TX

```js
await radio.transmitPacket([0xaa, 0x55, 0x01], {
  band: BAND.MHZ_433,
  modulation: MODULATION.OOK,
  mode: RADIO_MODE.PACKET,
  packet: {
    lengthMode: PACKET_LENGTH_MODE.FIXED,
    length: 3,
  },
});
```

### Direct async RX

```js
await radio.startDirectAsyncRx({
  band: BAND.MHZ_433,
  modulation: MODULATION.OOK,
  mode: RADIO_MODE.DIRECT_ASYNC,
  gpio: {
    gdo0: GDO_SIGNAL.ASYNC_SERIAL_DATA,
    gdo2: GDO_SIGNAL.PQI,
  },
});
```

### Raw register configuration

You can still configure with register names:

```js
const { VALUE } = require("node-cc1101");

await radio.configureObject({
  preset: {
    IOCFG0: VALUE.IOCFG.ASYNC_SERIAL_DATA,
  },
  registers: {
    PKTLEN: 61,
  },
});
```

## Shell

Start the shell:

```bash
node radio-shell.js
```

Examples:

```text
cc1101> config set packet 433 ook
cc1101> listen start 20
cc1101> tx aa 55 01

cc1101> config set direct_async 433 ook
cc1101> live view 24 25 100 3000
cc1101> protocol detect 24 100 375
cc1101> raw listen 24 100 220
cc1101> segment collect 24 100 400 500
cc1101> consensus start 24 100 400 1000 1000
cc1101> capture save 24 100 400 1000 1000 /tmp/rf-captures
cc1101> capture replay /tmp/rf-captures/capture-001.json 24 normalized 10 400
```

### Main shell commands

- `connect [bus] [device] [speedHz]`
- `disconnect`
- `reset`
- `info`
- `status`
- `config show`
- `config set <packet|direct_async> [band] [modulation]`
- `gpio set [gdo0] [gdo2] [gdo1]`
- `listen start [pollMs]`
- `listen stop`
- `live view [gdo0] [gdo2] [threshold] [windowMs]`
- `raw listen [gpio] [threshold] [captureMs]`
- `signal detect [gdo0] [threshold] [lookbackMs] [settleMs]`
- `timing fixed [gdo0] [threshold] [baseUs] [lookbackMs]`
- `segment collect [gdo0] [threshold] [baseUs] [lookbackMs]`
- `burst match [gpio] [silenceGapUs] [minEdges] [baseUnitUs]`
- `canonical build [gpio] [silenceGapUs] [minEdges] [baseUnitUs]`
- `stabilize frame [gdo0] [threshold] [baseUs] [lookbackMs]`
- `consensus start [gdo0] [threshold] [baseUs] [beforeMs] [afterMs]`
- `slice inspect [gdo0] [threshold] [baseUs] [beforeMs] [afterMs]`
- `frame extract [gdo0] [gdo2] [threshold] [silenceGapUs] [minEdges]`
- `capture save [gdo0] [threshold] [baseUs] [beforeMs] [afterMs] [outDir]`
- `capture show <file>`
- `capture replay <file> [gpio] [mode] [repeats] [baseUs]`
- `protocol detect [gdo0] [threshold] [baseUs]`
- `protocol listen [name] [gdo0] [threshold] [baseUs] [tolerance]`
- `protocol stop`
- `rssi [count] [intervalMs]`
- `tx <hex-bytes...>`
- `idle`

Detailed shell documentation is available in [SHELL.md](/home/lex/projects/node-cc1101/SHELL.md).

## Project structure

- [`index.js`](/home/lex/projects/node-cc1101/index.js): public package entrypoint
- [`cc1101/driver.js`](/home/lex/projects/node-cc1101/cc1101/driver.js): low-level SPI driver and high-level radio helpers
- [`cc1101/profiles.js`](/home/lex/projects/node-cc1101/cc1101/profiles.js): presets, config validation, and config translation
- [`cc1101/constants.js`](/home/lex/projects/node-cc1101/cc1101/constants.js): register, strobe, status, and descriptive value enums
- [`cc1101/analysis/`](/home/lex/projects/node-cc1101/cc1101/analysis): reusable analysis and replay modules
- [`radio-shell.js`](/home/lex/projects/node-cc1101/radio-shell.js): interactive CLI shell

## Notes

- Packet mode and direct async mode are intentionally separate in the API.
- Direct async mode in this project is aimed primarily at OOK analysis workflows.
- Timing-sensitive replay in Node.js is still subject to Linux scheduling jitter.
- Hardware behavior depends on the specific CC1101 board, antenna, voltage level, and GPIO wiring.

## Validation

Syntax check:

```bash
npm run check
```

Full library API documentation is available in [API.md](/home/lex/projects/node-cc1101/API.md).
