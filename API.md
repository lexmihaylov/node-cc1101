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

The streamlined analysis surface keeps a small set of reusable modules for raw listen, stream recording, stream analysis, protocol decoding, and replay.

Protocol decoder names currently implemented in [`protocol-analysis.js`](/home/lex/projects/node-cc1101/cc1101/analysis/protocol-analysis.js):

- `ev1527_like`
- `pt2262_like`
- `generic_pwm_13`
- `pulse_distance_like`

### File and replay modules

#### [`capture-file.js`](/home/lex/projects/node-cc1101/cc1101/analysis/capture-file.js)

Functions:

- `buildCaptureFilepath(outDir, prefix, id, isoTs)`
- `saveCaptureFile(filepath, capture)`
- `loadCaptureFile(filepath)`
- `summarizeCaptureFile(capture)`

Use this for saving/loading stream, frame, and replay JSON files.

#### [`window-replay.js`](/home/lex/projects/node-cc1101/cc1101/analysis/window-replay.js)

Exports:

- `buildReplayFromCapture(capture, options?)`
- `CC1101WindowReplayer`

Purpose:

- create replay buffers from saved frame/capture files
- replay through GPIO in raw or normalized mode

### Runtime modules

#### [`raw-listener.js`](/home/lex/projects/node-cc1101/cc1101/analysis/raw-listener.js)

Class:

- `CC1101RawListener`

Purpose:

- trigger on RSSI
- capture raw edge windows from one GPIO
- produce summarized frame output

#### [`stream-recorder.js`](/home/lex/projects/node-cc1101/cc1101/analysis/stream-recorder.js)

Class:

- `CC1101StreamRecorder`

Purpose:

- record one continuous direct-async edge stream
- save it as JSON when stopped
- support multi-click recordings for later offline analysis

### Pure analysis modules

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

#### [`stream-analysis.js`](/home/lex/projects/node-cc1101/cc1101/analysis/stream-analysis.js)

Exports:

- `analyzeRecordedStream(stream, options?)`
- `buildStableFramePath(sourcePath)`

Purpose:

- split a recorded edge stream by silence gaps
- cluster repeating patterns
- derive a stable frame candidate
- export a replay-ready `*.stable-frame.json`

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

### Record, analyze, and replay

```js
const { loadCaptureFile } = require("./cc1101/analysis/capture-file");
const { CC1101StreamRecorder } = require("./cc1101/analysis/stream-recorder");
const {
  analyzeRecordedStream,
  buildStableFramePath,
} = require("./cc1101/analysis/stream-analysis");
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
const analysis = analyzeRecordedStream(saved, {
  exportPath: buildStableFramePath("/tmp/rf-captures/session-001.json"),
});
const stable = loadCaptureFile(analysis.exportPath);
const replay = buildReplayFromCapture(stable, { mode: "normalized", baseUs: 400 });

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
