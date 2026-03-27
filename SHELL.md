# CC1101 Shell Guide

This document covers the interactive shell in [`radio-shell.js`](/home/lex/projects/node-cc1101/radio-shell.js).

The shell is intentionally small. It focuses on:

- packet RX/TX
- direct async listening
- recording raw edge streams
- extracting stable repeating frames from a stream
- decoding likely protocol payloads
- replaying a saved frame

Supported decoder names currently include:

- `ev1527_like`
- `pt2262_like`
- `generic_pwm_13`
- `pulse_distance_like`

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

## Model

The shell works in two radio modes:

- `packet`
  FIFO RX/TX traffic.
- `direct_async`
  GPIO-driven OOK workflows: listen, record, analyze, decode, replay.

Only one active runtime runs at a time. Starting `listen`, `record`, or `replay` stops the previous runtime first.

Defaults:

- `band = 433`
- `modulation = ook`
- `GDO0 -> GPIO24`
- `GDO2 -> GPIO25`

## Commands

- `help`
- `man [command]`
- `connect [bus] [device] [speedHz]`
- `disconnect`
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
- `clear`
- `quit`

## Command details

### `man [command]`

Shows detailed built-in shell documentation.

Examples:

```text
cc1101> man
cc1101> man listen
cc1101> man replay
```

Without arguments it lists the available manual entries. With a command name it prints detailed usage, mode-specific behavior, and explanations for each option.

### `mode [packet|direct_async] [band] [modulation]`

Shows the current mode when called without arguments.

Examples:

```text
cc1101> mode
cc1101> mode packet 433 ook
cc1101> mode direct_async 433 ook
```

### `listen [pollMs|gpio] [threshold] [captureMs] [rssiTolerance]`

Mode-sensitive listen command:

- in `packet` mode, starts FIFO packet RX polling
- in `direct_async` mode, starts a raw OOK edge listener on the chosen GPIO

Examples:

```text
cc1101> mode packet 433 ook
cc1101> listen 20

cc1101> mode direct_async 433 ook
cc1101> listen 24 100 220 6
```

### `send`

Mode-sensitive send command:

- in `packet` mode, accepts payload bytes
- in `direct_async` mode, accepts a replayable frame/capture file and forwards to the replay path

Examples:

```text
cc1101> mode packet 433 ook
cc1101> send aa 55 01

cc1101> mode direct_async 433 ook
cc1101> send /tmp/rf-captures/session-001.stable-frame.json 24 normalized 10 400
```

### `record <file> [rxDataGpio] [baseUs] [minDtUs]`

Records a continuous direct-async edge stream to one JSON file. Use this when you want multiple clicks or presses in one recording and want to extract repeating patterns later.

While recording, the shell renders a continuously updating live preview of recent edges, quantized timing units, and best-effort segment bits when enough recent data is available.

Example:

```text
cc1101> mode direct_async 433 ook
cc1101> record /tmp/rf-captures/session-001.json 24 400 80
cc1101> stop
```

### `analyze stream <file> [baseUs] [silenceUnits] [minBurstEdges] [tolerance]`

Loads a recorded stream, splits it into bursts, clusters repeating patterns, guesses a likely protocol, and writes the best stable frame to a sidecar file ending in `.stable-frame.json`.

Example:

```text
cc1101> analyze stream /tmp/rf-captures/session-001.json 400 18 8 1
```

### `decode <protocol> <file> [baseUs] [silenceUnits] [minBurstEdges] [tolerance]`

Runs a specific protocol decoder against either:

- a stable frame file
- a replayable capture file
- a raw recorded stream, in which case the shell first extracts the best stable frame

Example:

```text
cc1101> decode ev1527_like /tmp/rf-captures/session-001.stable-frame.json
```

### `replay <file> [txDataGpio] [timing] [repeats] [baseUs]`

Replays a saved frame or capture file through the Raspberry Pi GPIO line that feeds the CC1101 async TX data input.

Example:

```text
cc1101> replay /tmp/rf-captures/session-001.stable-frame.json 24 normalized 10 400
```

### `show <file>`

Prints a summary of a saved stream, frame, or capture file.

### `stop`

Stops the active packet listener or direct-async runtime.

### `idle`

Stops active work and sends the radio to IDLE.

## Typical workflow

```text
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

These are opposite directions on the same CC1101 data pin. Run one mode at a time.
