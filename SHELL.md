# CC1101 Shell Guide

This document covers the interactive shell in [`radio-shell.js`](/home/lex/projects/node-cc1101/radio-shell.js).

The shell is intentionally small and raw-data oriented. It focuses on:

- packet RX/TX
- direct async raw edge listening
- continuous raw stream recording
- continuously updating live preview during recording
- raw replay through direct async TX

## Start

Run:

```bash
node radio-shell.js
```

Or if installed as a package binary:

```bash
cc1101-shell
```

The shell connects on startup using:

- SPI bus `0`
- SPI device `0`
- SPI speed `100000`

Override them at launch with:

```bash
node radio-shell.js --bus 0 --device 0 --speed 100000
```

Shell defaults for SPI, mode, GPIO pins, direct-async routing, and filter values live in [`config.js`](/home/lex/projects/node-cc1101/config.js).

## Model

The shell works in two radio modes:

- `packet`
  FIFO RX/TX traffic.
- `direct_async`
  GPIO-based raw OOK workflows: listen, record, replay.

Only one active runtime runs at a time. Starting `listen`, `record`, or `replay` stops the previous runtime first.

Defaults:

- `band = 433`
- `modulation = ook`
- `RX: GDO2 -> GPIO25`
- `TX: GDO0 -> GPIO24`

## Commands

- `help`
- `man [command]`
- `connect [bus] [device] [speedHz]`
- `disconnect`
- `status`
- `spectrum [startMHz] [stopMHz] [stepKHz] [dwellMs] [samples]`
- `spectrum live [startMHz] [stopMHz] [stepKHz] [dwellMs] [samples]`
- `mode [packet|direct_async] [band] [modulation]`
- `listen [pollMs]`
- `listen [silenceGapUs] [sampleRateUs]`
- `send <hex-bytes...>`
- `send <file> [frameIndex] [silenceGapUs] [sampleRateUs] [repeats] [invert]`
- `record <file>`
- `replay <file> [frameIndex] [silenceGapUs] [sampleRateUs] [repeats] [invert]`
- `show <file> [silenceGapUs] [sampleRateUs]`
- `stop`
- `idle`
- `clear`
- `quit`

## Command details

### `man [command]`

Shows detailed built-in shell documentation.

Examples:

```text
cc1101> man
cc1101> man listen
cc1101> man record
cc1101> man replay
```

### `mode [packet|direct_async] [band] [modulation]`

Shows the current mode when called without arguments.

Supported band values are `315`, `433`, `868`, and `915`.
Supported modulation values are `ook`, `fsk`, `2fsk`, `gfsk`, and `msk`.

Examples:

```text
cc1101> mode
cc1101> mode packet 433 ook
cc1101> mode direct_async 433 ook
```

### `spectrum [startMHz] [stopMHz] [stepKHz] [dwellMs] [samples]`

### `spectrum live [startMHz] [stopMHz] [stepKHz] [dwellMs] [samples]`

Sweeps a frequency range and prints a terminal RSSI spectrum view.

Arguments:

- `startMHz`: sweep start frequency in MHz
- `stopMHz`: sweep stop frequency in MHz
- `stepKHz`: frequency step size in kHz, default `50`
- `dwellMs`: settle time after each retune, default `20`
- `samples`: number of RSSI reads averaged per point, default `3`

If `startMHz` and `stopMHz` are omitted, the shell uses a small default span around the current band:

- `315`: `314-316 MHz`
- `433`: `433-435 MHz`
- `868`: `867-869 MHz`
- `915`: `914-916 MHz`

Examples:

```text
cc1101> spectrum
cc1101> spectrum live
cc1101> spectrum 433.7 434.2 25 25 5
cc1101> spectrum 868.0 869.0 100 15 2
```

`spectrum live` repeats the sweep continuously and redraws the terminal with braille-style cells for a denser graph. Stop it with `stop` or Ctrl+C.

This is a received-power sweep using RSSI. It is not an IQ capture, waterfall, or protocol decoder.

### `listen [pollMs]`

### `listen [silenceGapUs] [sampleRateUs]`

Mode-sensitive listen command:

- in `packet` mode, starts FIFO packet RX polling
- in `direct_async` mode, starts a raw edge listener on the chosen GPIO

Examples:

```text
cc1101> mode packet 433 ook
cc1101> listen 20

cc1101> mode direct_async 433 ook
cc1101> listen 10000 250
```

In direct-async mode the listener has two states:

- `silence`
- `signal_detected`

It starts in `silence`. The first edge changes the state to `signal_detected`. If no new edge arrives for at least `silenceGapUs`, the listener returns to `silence`. The edges collected between those two transitions are treated as one raw signal window and printed. Even a single edge is emitted as a signal window.

Each printed raw signal includes:

- `shape`: one Unicode bar-height symbol per edge, scaled by relative duration within that signal
- `timeline`: a stretched high/low bar view over time
- `bits`: a colored bit view derived from the smallest edge duration over `125us`
- `edges`: the raw `level@duration` values

Live `listen` output is raw and unfiltered.

Arguments:

- `pollMs`: packet mode only polling interval
- `sampleRateUs`: optional preferred bit unit size for the live `bits` row

The direct-async RX GPIO is taken from [`config.js`](/home/lex/projects/node-cc1101/config.js). The current default is `GPIO25`.

### `send`

Mode-sensitive send command:

- in `packet` mode, accepts payload bytes
- in `direct_async` mode, accepts a saved raw edge file and forwards to replay

Examples:

```text
cc1101> mode packet 433 ook
cc1101> send aa 55 01

cc1101> mode direct_async 433 ook
cc1101> send /tmp/rf-captures/session-001.json 0 10000 250 10 false
```

### `record <file>`

Records a continuous raw direct-async edge stream to one JSON file.

Arguments:

- `file`: output JSON file

While recording, the shell renders a continuously updating sampled live preview over the recent time window. The preview shows:

- sampled activity over time
- sampled level over time
- rough raw duration class over time
- most recent raw edge values as `level@dtUs`

Every observed edge is recorded. No duration threshold, snapping, normalization, trimming, decoding, or frame extraction is performed.

The direct-async RX GPIO is taken from [`config.js`](/home/lex/projects/node-cc1101/config.js). The current default is `GPIO25`.

Example:

```text
cc1101> mode direct_async 433 ook
cc1101> record /tmp/rf-captures/session-001.json
cc1101> stop
```

### `replay <file> [frameIndex] [silenceGapUs] [sampleRateUs] [repeats] [invert]`

Replays a saved raw edge file through the Raspberry Pi GPIO line that feeds the CC1101 async TX data input.

Arguments:

- `file`: saved raw edge JSON file
- `frameIndex`: frame number identified from the saved stream, default `0`
- `silenceGapUs`: silence threshold used to split the stream into frames, default `10000`
- `sampleRateUs`: optional extracted-frame sample rate / bit duration threshold
- `repeats`: number of times to transmit the sequence, default `10`
- `invert`: invert replay polarity, default `false`

For raw stream files, replay first segments the file into silence-delimited frames, then replays the selected frame with its first edge rebased to `0 us`.
Before replay, the extracted frame is also passed through the same `150us` minimum pulse width filter used by `show`.
The direct-async TX GPIO is taken from [`config.js`](/home/lex/projects/node-cc1101/config.js). The current default is `GPIO24`.

Example:

```text
cc1101> replay /tmp/rf-captures/session-001.json 0 10000 250 10 false
```

### `show <file> [silenceGapUs] [sampleRateUs]`

Prints a short summary of a saved JSON file.

For raw edge files, `show` also renders:

- `frames`: segmentation summary using the supplied silence threshold
- `shape`: compact per-edge duration shape
- `timeline`: scaled high/low timing view
- `bits`: colored bit view derived from the smallest edge duration over `125us`
- `edges`: raw `level@duration` labels

Arguments:

- `silenceGapUs`: silence threshold used to split the saved stream into frames, default `10000`
- `sampleRateUs`: optional extracted-frame sample rate / bit duration threshold

Extracted frames are rendered after applying the same `150us` minimum pulse width filter used by `replay`.

### `stop`

Stops the active packet listener or direct-async runtime.

### `idle`

Stops active work and sends the radio to IDLE.

## Typical workflow

```text
cc1101> mode direct_async 433 ook
cc1101> record /tmp/rf-captures/session-001.json
cc1101> stop
cc1101> show /tmp/rf-captures/session-001.json 10000 250
cc1101> replay /tmp/rf-captures/session-001.json 0 10000 250 10 false
```

Direct async wiring model:

- RX/listen/record: `CC1101 GDO2 async-data output -> Raspberry Pi input GPIO`
- TX/replay: `Raspberry Pi output GPIO -> CC1101 GDO0 async TX data input`

These are opposite directions on the same CC1101 data pin. Run one mode at a time.
