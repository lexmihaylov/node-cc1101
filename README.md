# node-cc1101

Node.js CC1101 library and Raspberry Pi RF toolkit for 433/868/915 MHz over SPI and GPIO.

This project has two parts:

- A reusable CC1101 driver and radio configuration library under [`cc1101/`](/home/lex/projects/node-cc1101/cc1101)
- An interactive shell in [`radio-shell.js`](/home/lex/projects/node-cc1101/radio-shell.js) for listening, recording, decoding, and replaying signals

## Features

- SPI driver for CC1101 register access, strobes, FIFO RX/TX, and status reads
- High-level radio configuration with `configureRadio(...)`
- Packet mode helpers for RX/TX
- Direct async mode helpers for raw OOK work
- Stream-first analysis modules for recording, clustering repeating patterns, decoding likely protocols, and replay
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
cc1101> mode packet 433 ook
cc1101> listen 20
cc1101> send aa 55 01

cc1101> mode direct_async 433 ook
cc1101> record /tmp/rf-captures/session-001.json 24 400 80
cc1101> stop
cc1101> analyze stream /tmp/rf-captures/session-001.json 400 18 8 1
cc1101> decode ev1527_like /tmp/rf-captures/session-001.stable-frame.json
cc1101> replay /tmp/rf-captures/session-001.stable-frame.json 24 normalized 10 400
```

Direct async wiring model:

- RX/listen/record: `CC1101 GDO0 async-data output -> Raspberry Pi input GPIO`
- TX/replay: `Raspberry Pi output GPIO -> CC1101 GDO0 async TX data input`

### Main shell commands

- `connect [bus] [device] [speedHz]`
- `disconnect`
- `man [command]`
- `status`
- `mode [packet|direct_async] [band] [modulation]`
- `listen [pollMs|gpio] [threshold] [captureMs] [rssiTolerance]`
- `send <hex-bytes...>`
- `send <file> [txDataGpio] [timing] [repeats] [baseUs]`
- `record <file> [rxDataGpio] [baseUs] [minDtUs]`
- `analyze stream <file> [baseUs] [silenceUnits] [minBurstEdges] [tolerance]`
- `decode <protocol> <file> [baseUs] [silenceUnits] [minBurstEdges] [tolerance]`
- `replay <file> [txDataGpio] [timing] [repeats] [baseUs]`
- `show <file>`
- `stop`
- `idle`

Supported decoder names currently include:

- `ev1527_like`
- `pt2262_like`
- `generic_pwm_13`
- `pulse_distance_like`

Detailed shell documentation is available in [SHELL.md](/home/lex/projects/node-cc1101/SHELL.md).

The shell also includes a built-in manual:

```text
cc1101> man
cc1101> man listen
cc1101> man decode
```

During `record`, the shell renders a continuously updating sampled live preview over the recent time window, along with quantized timing units and best-effort segment bits while still saving the full raw stream.

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
