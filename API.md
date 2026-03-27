# API

This document covers the code-facing API for `node-cc1101`.

Main files:

- [`index.js`](/home/lex/projects/node-cc1101/index.js)
- [`cc1101/driver.js`](/home/lex/projects/node-cc1101/cc1101/driver.js)
- [`cc1101/profiles.js`](/home/lex/projects/node-cc1101/cc1101/profiles.js)
- [`cc1101/constants.js`](/home/lex/projects/node-cc1101/cc1101/constants.js)
- [`cc1101/utils.js`](/home/lex/projects/node-cc1101/cc1101/utils.js)
- [`cc1101/analysis/`](/home/lex/projects/node-cc1101/cc1101/analysis)

## Package exports

Exported from [`index.js`](/home/lex/projects/node-cc1101/index.js):

- `CC1101Driver`
- all exports from [`cc1101/constants.js`](/home/lex/projects/node-cc1101/cc1101/constants.js)
- all exports from [`cc1101/profiles.js`](/home/lex/projects/node-cc1101/cc1101/profiles.js)
- all exports from [`cc1101/utils.js`](/home/lex/projects/node-cc1101/cc1101/utils.js)

## Driver

Primary class:

- `CC1101Driver`

Common methods:

- `open()`
- `close()`
- `reset()`
- `idle()`
- `readRegister(address)`
- `writeRegister(address, value)`
- `readBurst(address, length)`
- `writeBurst(address, values)`
- `configureRadio(options)`
- `startPacketRx(options)`
- `transmitPacket(payload, options)`
- `startDirectAsyncRx(options)`
- `startDirectAsyncTx(options)`
- `readFifoPacket()`
- `getChipInfo()`
- `verifyChip()`

The implementation lives in [`cc1101/driver.js`](/home/lex/projects/node-cc1101/cc1101/driver.js).

## Radio profiles

Profile helpers live in [`cc1101/profiles.js`](/home/lex/projects/node-cc1101/cc1101/profiles.js).

Important enums:

- `BAND`
- `MODULATION`
- `RADIO_MODE`
- `GDO_SIGNAL`
- `PACKET_LENGTH_MODE`

Important helpers:

- `getCommonPreset(options?)`
- `getPacketPreset(options?)`
- `getDirectAsyncPreset(options?)`
- `buildRadioConfig(options?)`
- `validateRadioConfig(options?)`

## Analysis modules

The current analysis surface is intentionally minimal and raw-data oriented.

### [`capture-file.js`](/home/lex/projects/node-cc1101/cc1101/analysis/capture-file.js)

Functions:

- `buildCaptureFilepath(outDir, prefix, id, isoTs)`
- `saveCaptureFile(filepath, capture)`
- `loadCaptureFile(filepath)`
- `summarizeCaptureFile(capture)`

Use this for saving/loading raw stream and replay JSON files.

### [`raw-listener.js`](/home/lex/projects/node-cc1101/cc1101/analysis/raw-listener.js)

Class:

- `CC1101RawListener`

Purpose:

- RSSI-triggered raw edge capture from one GPIO
- no normalization or protocol decoding
- raw durations and levels only

### [`stream-recorder.js`](/home/lex/projects/node-cc1101/cc1101/analysis/stream-recorder.js)

Class:

- `CC1101StreamRecorder`

Purpose:

- continuous raw edge recording
- continuously updating live preview
- no snapping, trimming, normalization, or frame extraction

### [`window-replay.js`](/home/lex/projects/node-cc1101/cc1101/analysis/window-replay.js)

Exports:

- `buildReplayFromCapture(capture, options?)`
- `CC1101WindowReplayer`

Purpose:

- replay saved raw edge files through GPIO
- use stored `dtUs` durations directly

## Common usage

### Minimal packet RX

```js
const { CC1101Driver, BAND, MODULATION, RADIO_MODE } = require("node-cc1101");

const radio = new CC1101Driver({ bus: 0, device: 0, speedHz: 100000 });
await radio.open();
await radio.reset();
await radio.verifyChip();

await radio.startPacketRx({
  band: BAND.MHZ_433,
  modulation: MODULATION.OOK,
  mode: RADIO_MODE.PACKET,
});

const packet = await radio.readFifoPacket();
console.log(packet);
```

### Raw direct-async record and replay

```js
const { loadCaptureFile } = require("./cc1101/analysis/capture-file");
const { CC1101StreamRecorder } = require("./cc1101/analysis/stream-recorder");
const {
  buildReplayFromCapture,
  CC1101WindowReplayer,
} = require("./cc1101/analysis/window-replay");

const recorder = new CC1101StreamRecorder({
  rxDataGpio: 24,
  filepath: "/tmp/rf-captures/session-001.json",
});

await recorder.start();
await recorder.stop();

const saved = loadCaptureFile("/tmp/rf-captures/session-001.json");
const replay = buildReplayFromCapture(saved);

const replayer = new CC1101WindowReplayer({
  gpio: 24,
  repeats: 10,
});

await replayer.replay(replay);
```

## Typing

The library uses JSDoc with `// @ts-check` in the source files. Editors with TypeScript support should provide:

- autocomplete
- constructor option hints
- method signatures
- typedef navigation
