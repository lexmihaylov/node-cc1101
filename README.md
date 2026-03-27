# node-cc1101

Node.js CC1101 library and Raspberry Pi RF toolkit for 433/868/915 MHz over SPI and GPIO.

This project has two parts:

- a reusable CC1101 driver and radio configuration library under [`cc1101/`](/home/lex/projects/node-cc1101/cc1101)
- an interactive shell in [`radio-shell.js`](/home/lex/projects/node-cc1101/radio-shell.js) for packet RX/TX, raw direct-async edge listening, raw stream recording, and raw replay

## Features

- SPI driver for CC1101 register access, strobes, FIFO RX/TX, and status reads
- high-level radio configuration with `configureRadio(...)`
- packet mode helpers for RX/TX
- direct async mode helpers for raw OOK work
- raw edge listener for direct async RX
- raw stream recorder with continuous live preview
- raw replay through a Raspberry Pi GPIO driving CC1101 `GDO0` in TX

## Requirements

- Raspberry Pi with SPI enabled
- CC1101 module wired to Raspberry Pi SPI pins
- Node.js 18+
- native build support required by `pigpio` and `spi-device`

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

Typical GPIO wiring for direct async work:

- `GDO0` -> a Pi GPIO input for RX, commonly `GPIO24`
- `GDO2` -> optional Pi GPIO input for status/observation, commonly `GPIO25`

Direct async wiring model:

- RX/listen/record: `CC1101 GDO0 async-data output -> Raspberry Pi input GPIO`
- TX/replay: `Raspberry Pi output GPIO -> CC1101 GDO0 async TX data input`

These are opposite directions on the same CC1101 data pin. Run one mode at a time.

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
cc1101> record /tmp/rf-captures/session-001.json 24
cc1101> stop
cc1101> show /tmp/rf-captures/session-001.json 10000
cc1101> replay /tmp/rf-captures/session-001.json 0 10000 24 10 false
```

### Main shell commands

- `connect [bus] [device] [speedHz]`
- `disconnect`
- `man [command]`
- `status`
- `mode [packet|direct_async] [band] [modulation]`
- `listen [pollMs|gpio] [silenceGapUs]`
- `send <hex-bytes...>`
- `send <file> [frameIndex] [silenceGapUs] [txDataGpio] [repeats] [invert]`
- `record <file> [rxDataGpio]`
- `replay <file> [frameIndex] [silenceGapUs] [txDataGpio] [repeats] [invert]`
- `show <file> [silenceGapUs]`
- `stop`
- `idle`

Supported band values are `315`, `433`, `868`, and `915`.

The shell includes a built-in manual:

```text
cc1101> man
cc1101> man listen
cc1101> man record
cc1101> man replay
```

During `record`, the shell renders a continuously updating sampled live preview over the recent time window and shows raw edge transitions as `level@dtUs`. Every observed edge is recorded; no duration threshold is applied.

During direct-async `listen` and `show`, raw signals are also rendered with:

- a compact `shape` row using Unicode bar-height symbols per edge
- a scaled `timeline` row using high/low bar segments stretched across time

This is display-only scaling. Stored timings remain raw microseconds.

When frames are segmented for `show` or extracted for `replay`, a built-in minimum pulse width filter removes brief pulse excursions up to `150us`. The saved raw stream is not modified, and live `listen` output remains raw.

For saved raw streams, `show` uses the supplied `silenceGapUs` to split the recording into frames. `replay` uses the same silence rule and frame index, then replays that frame rebased to time zero so the leading silence before the frame is not transmitted.
Single-edge signals and single-edge frames are kept.

In direct-async `listen`, the shell uses a simple state machine:

- starts in `silence`
- first edge switches to `signal_detected`
- if no edge arrives for `silenceGapUs`, the state returns to `silence`
- edges collected between those transitions are emitted as one raw signal window

Detailed shell documentation is available in [SHELL.md](/home/lex/projects/node-cc1101/SHELL.md).

## Project structure

- [`index.js`](/home/lex/projects/node-cc1101/index.js): public package entrypoint
- [`cc1101/driver.js`](/home/lex/projects/node-cc1101/cc1101/driver.js): low-level SPI driver and high-level radio helpers
- [`cc1101/profiles.js`](/home/lex/projects/node-cc1101/cc1101/profiles.js): presets, config validation, and config translation
- [`cc1101/constants.js`](/home/lex/projects/node-cc1101/cc1101/constants.js): register, strobe, status, and descriptive value enums
- [`cc1101/analysis/raw-listener.js`](/home/lex/projects/node-cc1101/cc1101/analysis/raw-listener.js): silence-delimited raw edge listener
- [`cc1101/analysis/stream-recorder.js`](/home/lex/projects/node-cc1101/cc1101/analysis/stream-recorder.js): continuous raw edge recording with live preview
- [`cc1101/analysis/window-replay.js`](/home/lex/projects/node-cc1101/cc1101/analysis/window-replay.js): raw replay through GPIO
- [`radio-shell.js`](/home/lex/projects/node-cc1101/radio-shell.js): interactive CLI shell

## Notes

- packet mode and direct async mode are intentionally separate in the API
- direct async mode in this project is aimed primarily at raw OOK edge work
- no normalization, snapping, trimming, frame extraction, or protocol decoding is performed in the current shell workflow
- timing-sensitive replay in Node.js is still subject to Linux scheduling jitter

## Validation

Syntax check:

```bash
npm run check
```

Full library API documentation is available in [API.md](/home/lex/projects/node-cc1101/API.md).
