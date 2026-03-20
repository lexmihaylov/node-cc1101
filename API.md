# API Reference

This document covers the code-facing API for `node-cc1101`.

Public package entrypoint:

- [`index.js`](/home/lex/projects/node-cc1101/index.js)

Core implementation:

- [`cc1101/driver.js`](/home/lex/projects/node-cc1101/cc1101/driver.js)
- [`cc1101/profiles.js`](/home/lex/projects/node-cc1101/cc1101/profiles.js)
- [`cc1101/constants.js`](/home/lex/projects/node-cc1101/cc1101/constants.js)
- [`cc1101/utils.js`](/home/lex/projects/node-cc1101/cc1101/utils.js)
- [`cc1101/analysis/`](/home/lex/projects/node-cc1101/cc1101/analysis)

## Package entrypoint

Import from the package root:

```js
const {
  CC1101Driver,
  REG,
  STATUS,
  STROBE,
  VALUE,
  BAND,
  MODULATION,
  RADIO_MODE,
  GDO_SIGNAL,
  PACKET_LENGTH_MODE,
  utils,
} = require("node-cc1101");
```

Exported from [`index.js`](/home/lex/projects/node-cc1101/index.js):

- `CC1101Driver`
- all exports from [`cc1101/constants.js`](/home/lex/projects/node-cc1101/cc1101/constants.js)
- all exports from [`cc1101/profiles.js`](/home/lex/projects/node-cc1101/cc1101/profiles.js)
- `utils`

Note:

- Analysis modules are currently imported from their module paths under [`cc1101/analysis/`](/home/lex/projects/node-cc1101/cc1101/analysis), not from the package root.

## Driver

Source:

- [`cc1101/driver.js`](/home/lex/projects/node-cc1101/cc1101/driver.js)

### `new CC1101Driver(options?)`

Creates a driver instance.

Options:

- `bus?: number`
- `device?: number`
- `speedHz?: number`
- `mode?: number`

Defaults come from [`DEFAULTS`](/home/lex/projects/node-cc1101/cc1101/constants.js).

Example:

```js
const radio = new CC1101Driver({
  bus: 0,
  device: 0,
  speedHz: 100000,
});
```

### Lifecycle methods

#### `open(): Promise<void>`

Opens the SPI device.

#### `close(): Promise<void>`

Closes the SPI device.

#### `reset(): Promise<void>`

Sends `SRES` and waits briefly.

#### `idle(): Promise<void>`

Sends `SIDLE`.

### Low-level SPI/register methods

#### `transfer(sendBytes: number[]): Promise<number[]>`

Performs a raw SPI transfer.

#### `strobe(command: number): Promise<number>`

Sends a command strobe.

#### `writeRegister(address: number, value: number): Promise<void>`

Writes a single register.

#### `readRegister(address: number): Promise<number>`

Reads a register.

#### `writeBurst(address: number, values: number[]): Promise<void>`

Writes a burst register/FIFO sequence.

#### `readBurst(address: number, length: number): Promise<number[]>`

Reads a burst register/FIFO sequence.

#### `debugRead(address: number, accessMode: number): Promise<number[]>`

Low-level helper for SPI/debug inspection.

### Radio state helpers

#### `flushRx(): Promise<void>`

Idles the radio and sends `SFRX`.

#### `flushTx(): Promise<void>`

Idles the radio and sends `SFTX`.

#### `enterRx(): Promise<void>`

Sends `SRX`.

#### `enterTx(): Promise<void>`

Sends `STX`.

#### `enterRxSafe(): Promise<void>`

Safe RX entry sequence:

- `SIDLE`
- `SFRX`
- `SRX`

### Chip/status helpers

#### `getChipInfo(): Promise<ChipInfo>`

Returns:

- `partnum`
- `version`
- `marcstate`
- `rxbytes`
- `rxOverflow`

#### `verifyChip(): Promise<ChipInfo>`

Verifies the chip responds with sane `PARTNUM`/`VERSION` values and returns chip info.

#### `getRssi(): Promise<number>`

Reads raw RSSI.

### Packet/FIFO helpers

#### `readFifoPacket(): Promise<ReadFifoPacketResult>`

Reads a packet from the RX FIFO if available.

Possible result shapes:

- `{ overflow: true, packet: null }`
- `{ overflow: false, packet: null }`
- `{ overflow: false, packet: null, invalidLength: number }`
- `{ overflow: false, packet: { length, payload, status } }`

#### `sendPacket(payload: number[]): Promise<void>`

Legacy packet send helper using fixed packet length.

#### `sendTestPacket(bytes?: number[]): Promise<void>`

Writes a small test packet to TX FIFO and transmits it.

### Register-map configuration helpers

#### `applyRegisters(registerMap: Record<number, number>): Promise<void>`

Writes a numeric register map directly.

#### `resolveRegisterMap(config): Record<number, number>`

Turns a mixed object-based config into a numeric address map.

Accepts a shape like:

```js
{
  preset: { ... },
  registers: {
    PKTLEN: 61,
    IOCFG0: 0x0d,
  },
}
```

#### `configureObject(config): Promise<void>`

Applies a config object using register names and/or a preset.

Example:

```js
await radio.configureObject({
  registers: {
    PKTLEN: 61,
  },
});
```

### High-level radio configuration helpers

#### `configureRadio(options?): Promise<void>`

Builds a register preset from a high-level radio config and applies it.

This is the main high-level entrypoint for library users.

Example:

```js
await radio.configureRadio({
  band: "433",
  modulation: "ook",
  mode: "direct_async",
  gpio: {
    gdo0: "async_serial_data",
    gdo2: "pqi",
  },
});
```

#### `startPacketRx(options?): Promise<void>`

Configures packet mode and enters RX safely.

#### `transmitPacket(payload: number[], options?): Promise<void>`

Configures packet mode and transmits a payload.

#### `startDirectAsyncRx(options?): Promise<void>`

Configures direct async mode and enters RX safely.

#### `startDirectAsyncTx(options?): Promise<void>`

Configures direct async mode, flushes TX, and enters TX.

### Misc helpers

#### `setFrequency43392(): Promise<void>`

Legacy helper that writes the classic 433.92 MHz frequency word directly.

#### `configureBasicTx(): Promise<void>`

Legacy helper for a minimal TX setup.

## Profiles and radio config

Source:

- [`cc1101/profiles.js`](/home/lex/projects/node-cc1101/cc1101/profiles.js)

### Enums

#### `BAND`

Values:

- `BAND.MHZ_433`
- `BAND.MHZ_868`
- `BAND.MHZ_915`

#### `MODULATION`

Values:

- `MODULATION.OOK`
- `MODULATION.FSK`

#### `RADIO_MODE`

Values:

- `RADIO_MODE.PACKET`
- `RADIO_MODE.DIRECT_ASYNC`

#### `GDO_SIGNAL`

Values:

- `GDO_SIGNAL.CHIP_READY_N`
- `GDO_SIGNAL.HIGH_IMPEDANCE`
- `GDO_SIGNAL.PQI`
- `GDO_SIGNAL.ASYNC_SERIAL_DATA`

#### `PACKET_LENGTH_MODE`

Values:

- `PACKET_LENGTH_MODE.FIXED`
- `PACKET_LENGTH_MODE.VARIABLE`

### Preset builders

#### `getFrequencyRegisters(freqMHz: number): RegisterMap`

Returns the `FREQ2/FREQ1/FREQ0` register map for the requested MHz value.

#### `getCommonPreset(options?): RegisterMap`

Returns shared base registers for the selected band.

Options:

- `band?: Band`

#### `getPacketPreset(options?): RegisterMap`

Returns a packet-mode register preset.

Options:

- `band?: Band`
- `modulation?: Modulation`

#### `getDirectAsyncPreset(options?): RegisterMap`

Returns a direct async preset.

Options:

- `band?: Band`
- `modulation?: Modulation`
- `packetControl1?: number`
- `gdo0?: number`
- `gdo1?: number`
- `gdo2?: number`
- `agcCtrl2?: number`

#### `getDirectAsyncReceivePreset(options?): RegisterMap`

Alias for a receive-oriented direct async preset.

#### `getDirectAsyncTransmitPreset(options?): RegisterMap`

Alias for a transmit-oriented direct async preset.

#### `getBasePreset(options?): RegisterMap`

Compatibility wrapper that resolves to the appropriate preset based on mode.

### Validation and config translation

#### `validateRadioConfig(options?): void`

Validates a high-level radio config and throws for invalid combinations.

Checks include:

- invalid `band`, `modulation`, or `mode`
- unsupported direct async / modulation combinations
- invalid packet length fields
- invalid GDO fields or unsupported signal names
- packet-only fields used in direct async mode

#### `buildRadioConfig(options?): { preset: RegisterMap, registers: Record<string, number> }`

Translates a user-facing radio config object into:

- `preset`: numeric-address preset
- `registers`: named overrides

This is what `driver.configureRadio(...)` uses internally.

### `RadioConfigOptions`

Supported high-level shape:

```js
{
  band?: "433" | "868" | "915",
  modulation?: "ook" | "fsk",
  mode?: "packet" | "direct_async",
  gpio?: {
    gdo0?: GDO signal name or raw number,
    gdo1?: GDO signal name or raw number,
    gdo2?: GDO signal name or raw number,
  },
  packet?: {
    appendStatus?: boolean,
    lengthMode?: "fixed" | "variable",
    length?: number,
    control1?: number,
  },
  agcCtrl2?: number,
  registers?: Record<string, number>,
}
```

## Constants

Source:

- [`cc1101/constants.js`](/home/lex/projects/node-cc1101/cc1101/constants.js)

### Register/command maps

#### `REG`

CC1101 configuration register addresses.

Example:

- `REG.IOCFG2`
- `REG.PKTLEN`
- `REG.MDMCFG2`
- `REG.FREQ2`

#### `STATUS`

Status register addresses.

Example:

- `STATUS.RSSI`
- `STATUS.MARCSTATE`
- `STATUS.RXBYTES`

#### `STROBE`

Command strobe addresses.

Example:

- `STROBE.SRES`
- `STROBE.SRX`
- `STROBE.STX`

#### `FIFO`

FIFO addresses:

- `FIFO.TX`
- `FIFO.RX`

#### `ACCESS`

SPI access mode flags:

- `ACCESS.WRITE_BURST`
- `ACCESS.READ_SINGLE`
- `ACCESS.READ_BURST`

#### `DEFAULTS`

Driver defaults:

- `BUS`
- `DEVICE`
- `SPEED_HZ`
- `MODE`

### Descriptive value enums

#### `VALUE.IOCFG`

- `HIGH_IMPEDANCE`
- `CHIP_READY_N`
- `PQI`
- `ASYNC_SERIAL_DATA`

#### `VALUE.PKTCTRL0`

- `FIXED_LENGTH`
- `VARIABLE_LENGTH_WITH_CRC`
- `ASYNC_SERIAL_MODE`

#### `VALUE.PKTCTRL1`

- `NO_ADDRESS_CHECK`
- `APPEND_STATUS`
- `PQT_1`

#### `VALUE.MDMCFG2`

- `FSK_PACKET`
- `OOK_NO_SYNC`

#### `VALUE.AGCCTRL2`

- `DEFAULT`
- `MAX_DVGA_GAIN`

## Utilities

Source:

- [`cc1101/utils.js`](/home/lex/projects/node-cc1101/cc1101/utils.js)

### `sleep(ms: number): Promise<void>`

Simple async delay helper.

### `hex(bytes: number[]): string`

Formats bytes as uppercase hex separated by spaces.

### `parseArgs(argv: string[]): ParsedArgs`

Parses simple `--key value` CLI argument pairs.

### `parsePayload(input?: string): number[]`

Parses a hex payload string into byte values.

Examples:

```js
parsePayload("aa 55 01");
parsePayload("0xaa 0x55 0x01");
```

## Analysis modules

All analysis modules live in:

- [`cc1101/analysis/`](/home/lex/projects/node-cc1101/cc1101/analysis)

Most runtime-style modules expose a class with:

- a constructor accepting options
- `start(): Promise<void>`
- `stop(): Promise<void>`

### Capture/replay modules

#### [`capture-file.js`](/home/lex/projects/node-cc1101/cc1101/analysis/capture-file.js)

Functions:

- `buildCaptureFilepath(outDir, prefix, id, isoTs)`
- `saveCaptureFile(filepath, capture)`
- `loadCaptureFile(filepath)`
- `summarizeCaptureFile(capture)`

Use this for saving/loading normalized capture JSON files.

#### [`window-capture.js`](/home/lex/projects/node-cc1101/cc1101/analysis/window-capture.js)

Class:

- `CC1101WindowCapture`

Purpose:

- RSSI-triggered capture windows
- quantized edge capture
- save-to-file workflows

Constructor options include:

- SPI options
- `gdo0`
- `threshold`
- `baseUs`
- `beforeMs`
- `afterMs`
- `outDir`
- callbacks like `onMessage` and `onCapture`

#### [`window-replay.js`](/home/lex/projects/node-cc1101/cc1101/analysis/window-replay.js)

Exports:

- `buildReplayFromCapture(capture, options?)`
- `CC1101WindowReplayer`

Purpose:

- create replay buffers from capture files
- replay through GPIO in raw or normalized mode

### Raw analysis modules

#### [`raw-analysis.js`](/home/lex/projects/node-cc1101/cc1101/analysis/raw-analysis.js)

Pure helpers:

- `median`
- `estimateBaseUnit`
- `normalizeToUnits`
- `splitIntoSegments`
- `classifyUnit`
- `segmentToSymbols`
- `compressSymbols`
- `classifyPair`
- `decodeSegmentToBits`
- `renderBars`
- `renderWaveform`
- `summarizeFrame`

Use these when you already have raw edge durations and want summary/decoding helpers without GPIO runtime code.

#### [`raw-listener.js`](/home/lex/projects/node-cc1101/cc1101/analysis/raw-listener.js)

Class:

- `CC1101RawListener`

Purpose:

- trigger on RSSI
- capture raw edge windows from one GPIO
- produce summarized frame output

### Protocol analysis modules

#### [`protocol-analysis.js`](/home/lex/projects/node-cc1101/cc1101/analysis/protocol-analysis.js)

Pure helpers:

- `quantizeEdges`
- `splitBySilence`
- `renderBars`
- `compactFrame`
- `frameStats`
- `scoreFrame`
- `rankProtocols`
- `detectProtocolCandidates`
- `decodeByProtocol`
- `decodeEv1527Like`
- `decodePt2262Like`
- `decodeGenericPwm13`
- `decodePulseDistanceLike`

Use this for pure protocol scoring and decoding.

#### [`protocol-detector.js`](/home/lex/projects/node-cc1101/cc1101/analysis/protocol-detector.js)

Class:

- `CC1101ProtocolDetector`

Purpose:

- configure the radio for direct async receive
- collect edges from `pigpio`
- rank protocol candidates

Constructor options include:

- `gdo0`
- `threshold`
- `baseUs`
- `onMessage`
- `onCandidate`

#### [`protocol-listener.js`](/home/lex/projects/node-cc1101/cc1101/analysis/protocol-listener.js)

Class:

- `CC1101ProtocolListener`

Purpose:

- listen for a chosen protocol family
- decode best candidate frames continuously

### Generic signal-analysis modules

#### [`signal-analysis.js`](/home/lex/projects/node-cc1101/cc1101/analysis/signal-analysis.js)

Pure helpers:

- `median`
- `roundToNiceTiming`
- `trimHistory`
- `quantizeEdges`
- `splitBySilence`
- `smoothQuantizedEdges`
- `buildSlice`
- `renderBars`
- `compactTokens`
- `compactFrame`
- `estimateTimingGrid`
- `scoreFrame`
- `scoreSegment`
- `clamp`
- `bestAlignment`
- `buildConsensus`
- `matchMask`

Use this for generic timing/consensus logic independent of a specific protocol family.

#### [`signal-detector.js`](/home/lex/projects/node-cc1101/cc1101/analysis/signal-detector.js)

Class:

- `CC1101SignalDetector`

Purpose:

- RSSI-triggered frame detection
- timing grid estimation
- candidate frame ranking

#### [`fixed-timing-detector.js`](/home/lex/projects/node-cc1101/cc1101/analysis/fixed-timing-detector.js)

Class:

- `CC1101FixedTimingDetector`

Purpose:

- same broad workflow as signal detector
- uses a caller-supplied fixed base timing

#### [`segment-collector.js`](/home/lex/projects/node-cc1101/cc1101/analysis/segment-collector.js)

Class:

- `CC1101SegmentCollector`

Purpose:

- collect repeated presses
- quantize to units
- split into segments
- compare recent captures

#### [`window-consensus.js`](/home/lex/projects/node-cc1101/cc1101/analysis/window-consensus.js)

Class:

- `CC1101WindowConsensus`

Purpose:

- capture windows around RSSI triggers
- build a running consensus across recent slices

#### [`live-visualizer.js`](/home/lex/projects/node-cc1101/cc1101/analysis/live-visualizer.js)

Class:

- `CC1101LiveVisualizer`

Purpose:

- terminal visualization of GDO0, GDO2, RSSI, and trigger windows

### Frame extraction/stabilization modules

#### [`frame-extractor.js`](/home/lex/projects/node-cc1101/cc1101/analysis/frame-extractor.js)

Class:

- `CC1101FrameExtractor`

Purpose:

- use `GDO0` and `GDO2` together
- identify likely framed regions
- print segmented frame views

#### [`frame-stabilizer.js`](/home/lex/projects/node-cc1101/cc1101/analysis/frame-stabilizer.js)

Class:

- `CC1101FrameStabilizer`

Purpose:

- choose the best frame per trigger
- compare against recent frames
- build stabilized consensus output

#### [`manual-slicer.js`](/home/lex/projects/node-cc1101/cc1101/analysis/manual-slicer.js)

Class:

- `CC1101ManualSlicer`

Purpose:

- inspect full trigger windows
- show indexed/smoothed quantized data
- support manual frame slicing work

### Burst matching/canonicalization modules

#### [`burst-analysis.js`](/home/lex/projects/node-cc1101/cc1101/analysis/burst-analysis.js)

Pure helpers:

- `normalizeBurst`
- `trimNoise`
- `splitIntoSubframes`
- `tokenString`
- `compactTokenString`
- `renderTokenBars`
- `tokensMatch`
- `bestWindowAlignment`
- `repeatedCore`
- `extractSharedWindow`
- `buildCanonicalFrame`

Use this for raw burst normalization and token-based comparison.

#### [`burst-matcher.js`](/home/lex/projects/node-cc1101/cc1101/analysis/burst-matcher.js)

Class:

- `CC1101BurstMatcher`

Purpose:

- collect bursts directly by silence gap
- normalize and compare them to recent bursts

#### [`canonical-frame.js`](/home/lex/projects/node-cc1101/cc1101/analysis/canonical-frame.js)

Class:

- `CC1101CanonicalFrameBuilder`

Purpose:

- compare repeated similar bursts
- derive a canonical frame from multiple captures

## Common usage patterns

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

### Direct async analysis runtime

```js
const { CC1101SignalDetector } = require("./cc1101/analysis/signal-detector");

const detector = new CC1101SignalDetector({
  gdo0: 24,
  threshold: 100,
  onMessage: console.log,
});

await detector.start();
```

### Capture and replay

```js
const { CC1101WindowCapture } = require("./cc1101/analysis/window-capture");
const {
  loadCaptureFile,
} = require("./cc1101/analysis/capture-file");
const {
  buildReplayFromCapture,
  CC1101WindowReplayer,
} = require("./cc1101/analysis/window-replay");

const capture = new CC1101WindowCapture({
  gdo0: 24,
  threshold: 100,
  baseUs: 400,
  outDir: "/tmp/rf-captures",
});

await capture.start();

const saved = loadCaptureFile("/tmp/rf-captures/capture-001.json");
const replay = buildReplayFromCapture(saved, { mode: "normalized", baseUs: 400 });

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

Primary typedef-heavy files:

- [`cc1101/driver.js`](/home/lex/projects/node-cc1101/cc1101/driver.js)
- [`cc1101/profiles.js`](/home/lex/projects/node-cc1101/cc1101/profiles.js)
- analysis class modules under [`cc1101/analysis/`](/home/lex/projects/node-cc1101/cc1101/analysis)
