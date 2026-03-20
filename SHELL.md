# CC1101 Shell Guide

This document covers the interactive shell in [`radio-shell.js`](/home/lex/projects/node-cc1101/radio-shell.js).

The shell is designed for Raspberry Pi based CC1101 work where you need to:

- connect to the radio over SPI
- switch between packet mode and direct async mode
- inspect RSSI and chip status
- receive and transmit packets
- capture and replay OOK traffic
- run protocol and timing analysis tools interactively

## Start the shell

Run:

```bash
node radio-shell.js
```

Or if installed as a package binary:

```bash
cc1101-shell
```

You should see a prompt like:

```text
cc1101>
```

The shell connects on startup using:

- SPI bus `0`
- SPI device `0`
- SPI speed `100000`

You can override those at launch:

```bash
node radio-shell.js --bus 0 --device 0 --speed 100000
```

## Shell model

The shell operates in two broad radio modes:

- `packet`
  Used for FIFO RX/TX packet traffic.
- `direct_async`
  Used for GPIO-driven waveform, timing, protocol, capture, and replay tooling.

Most analysis commands stop any previous runtime before starting a new one. This is intentional. The shell only runs one active GPIO/RF analysis runtime at a time.

## Defaults

Unless you override them in a command, the shell generally assumes:

- `band = 433`
- `modulation = ook`
- `packet mode` for normal RX/TX
- `gdo0 = GPIO24`
- `gdo2 = GPIO25`
- `threshold = 100`

## Command summary

- `help`
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
- `capture save [rxDataGpio] [threshold] [baseUs] [beforeMs] [afterMs] [outDir]`
- `capture show <file>`
- `capture replay <file> [txDataGpio] [mode] [repeats] [baseUs]`
- `protocol detect [gdo0] [threshold] [baseUs]`
- `protocol listen [name] [gdo0] [threshold] [baseUs] [tolerance]`
- `protocol stop`
- `rssi [count] [intervalMs]`
- `tx <hex-bytes...>`
- `idle`
- `quit`

## General commands

### `help`

Prints the shell command list and example flows.

Example:

```text
cc1101> help
```

### `connect [bus] [device] [speedHz]`

Connects to the CC1101 over SPI. If already connected, the shell disconnects first and reconnects with the new parameters.

Arguments:

- `bus`: SPI bus number
- `device`: SPI chip select number
- `speedHz`: SPI speed in Hz

Example:

```text
cc1101> connect 0 0 100000
```

### `disconnect`

Stops listeners/runtimes, idles the radio, and closes SPI.

Example:

```text
cc1101> disconnect
```

### `reset`

Sends `SRES` to the radio and resets runtime state in the shell.

Example:

```text
cc1101> reset
```

### `info`

Prints chip information from the driver. Useful for confirming the CC1101 is responding and the SPI link is healthy.

Example:

```text
cc1101> info
```

### `status`

Prints current radio status values such as:

- `MARCSTATE`
- `RSSI raw`
- `RSSI dBm`
- `PKTSTATUS`
- `RXBYTES`
- `TXBYTES`

Example:

```text
cc1101> status
```

### `idle`

Stops packet listening or active analysis runtime, then places the radio in IDLE.

Example:

```text
cc1101> idle
```

### `quit`

Exits the shell cleanly.

Example:

```text
cc1101> quit
```

## Radio configuration commands

### `config show`

Prints the shell's current in-memory radio configuration object.

Example:

```text
cc1101> config show
```

### `config set <packet|direct_async> [band] [modulation]`

Sets the current radio configuration used by other commands.

Arguments:

- `packet|direct_async`: radio mode
- `band`: `433`, `868`, or `915`
- `modulation`: `ook` or `fsk`

Examples:

```text
cc1101> config set packet 433 ook
cc1101> config set packet 433 fsk
cc1101> config set direct_async 433 ook
```

Notes:

- `direct_async` is intended for OOK workflows in this project.
- `tx` and `listen start` currently operate on packet mode.

### `gpio set [gdo0] [gdo2] [gdo1]`

Updates GDO routing in the current shell config.

Allowed symbolic values are:

- `chip_ready_n`
- `high_impedance`
- `pqi`
- `async_serial_data`

Example:

```text
cc1101> gpio set async_serial_data pqi high_impedance
```

This sets:

- `gdo0 = async_serial_data`
- `gdo2 = pqi`
- `gdo1 = high_impedance`

## Packet RX/TX commands

### `listen start [pollMs]`

Configures the radio for packet RX using the current shell config, then continuously polls the RX FIFO.

Arguments:

- `pollMs`: delay between FIFO polls, default `20`

Example:

```text
cc1101> config set packet 433 ook
cc1101> listen start 20
```

Typical output:

```text
[rx] len=5 payload=[AA 55 01 02 03] status=[7F 80]
```

Notes:

- This command is packet-mode only.
- If RX overflow occurs, the driver recovers and prints an overflow message.

### `listen stop`

Stops packet RX polling and idles the radio.

Example:

```text
cc1101> listen stop
```

### `tx <hex-bytes...>`

Transmits a packet using the current packet-mode config.

Arguments:

- one or more hex bytes, with or without `0x`

Examples:

```text
cc1101> tx aa 55 01
cc1101> tx 0xaa 0x55 0x01 0x02
```

Notes:

- This command is packet-mode only.
- The shell parses bytes as hex.

## RSSI and live visualization

### `rssi [count] [intervalMs]`

Samples RSSI repeatedly.

Arguments:

- `count`: number of samples, default `10`
- `intervalMs`: delay between samples, default `100`

Example:

```text
cc1101> rssi 20 100
```

### `live view [gdo0] [gdo2] [threshold] [windowMs]`

Starts a live terminal visualization of:

- `GDO0`
- `GDO2`
- RSSI history
- trigger windows

Arguments:

- `gdo0`: GPIO pin for GDO0, default `24`
- `gdo2`: GPIO pin for GDO2, default `25`
- `threshold`: RSSI trigger threshold, default `100`
- `windowMs`: time window shown in the UI, default `3000`

Example:

```text
cc1101> live view 24 25 100 3000
```

Notes:

- This is a continuously updating screen-oriented command.
- Stop it with `Ctrl+C`, `disconnect`, `idle`, `protocol stop`, or by starting another runtime.

## Direct async raw capture and signal inspection

### `raw listen [gpio] [threshold] [captureMs]`

Arms a raw trigger listener. When RSSI crosses the threshold, the shell captures a short burst of edges and prints a summarized view.

Arguments:

- `gpio`: GPIO pin carrying async serial data, default `24`
- `threshold`: RSSI trigger threshold, default `100`
- `captureMs`: capture window length in milliseconds, default `220`

Example:

```text
cc1101> raw listen 24 100 220
```

### `signal detect [gdo0] [threshold] [lookbackMs] [settleMs]`

Detects candidate frames from a triggered RSSI event and estimates likely timing clusters automatically.

Arguments:

- `gdo0`: GPIO pin, default `24`
- `threshold`: RSSI trigger threshold, default `100`
- `lookbackMs`: how much edge history to include before the trigger, default `1000`
- `settleMs`: time to wait after trigger before analyzing, default `220`

Example:

```text
cc1101> signal detect 24 100 1000 220
```

Use this when you do not yet know the base timing.

### `timing fixed [gdo0] [threshold] [baseUs] [lookbackMs]`

Like `signal detect`, but quantizes using a fixed base timing instead of estimating one.

Arguments:

- `gdo0`: GPIO pin, default `24`
- `threshold`: RSSI trigger threshold, default `100`
- `baseUs`: fixed unit in microseconds, default `500`
- `lookbackMs`: edge history window before the trigger, default `1000`

Example:

```text
cc1101> timing fixed 24 100 500 1000
```

Use this when you already know the protocol timing.

### `segment collect [gdo0] [threshold] [baseUs] [lookbackMs]`

Collects triggered windows, quantizes them to units, splits them into segments, and prints recent summaries so you can compare repeated presses.

Arguments:

- `gdo0`: GPIO pin, default `24`
- `threshold`: RSSI trigger threshold, default `100`
- `baseUs`: unit size in microseconds, default `400`
- `lookbackMs`: history before the trigger, default `500`

Example:

```text
cc1101> segment collect 24 100 400 500
```

### `slice inspect [gdo0] [threshold] [baseUs] [beforeMs] [afterMs]`

Captures a full trigger window and prints:

- indexed rows
- raw durations
- snapped durations
- units
- smoothed units
- a manual slice view if configured in code

Arguments:

- `gdo0`: GPIO pin, default `24`
- `threshold`: RSSI trigger threshold, default `100`
- `baseUs`: quantization base, default `400`
- `beforeMs`: window before trigger, default `1000`
- `afterMs`: window after trigger, default `1000`

Example:

```text
cc1101> slice inspect 24 100 400 1000 1000
```

This is useful when reverse-engineering frame boundaries manually.

## Protocol commands

### `protocol detect [gdo0] [threshold] [baseUs]`

Runs protocol detection against captured frames and prints ranked candidates.

Arguments:

- `gdo0`: GPIO pin, default `24`
- `threshold`: RSSI trigger threshold, default `100`
- `baseUs`: base timing in microseconds, default `375`

Example:

```text
cc1101> protocol detect 24 100 375
```

### `protocol listen [name] [gdo0] [threshold] [baseUs] [tolerance]`

Listens for a specific decoded protocol and prints decoded payloads.

Arguments:

- `name`: protocol name, default `ev1527_like`
- `gdo0`: GPIO pin, default `24`
- `threshold`: RSSI trigger threshold, default `100`
- `baseUs`: base timing in microseconds, default `375`
- `tolerance`: unit tolerance, default `1`

Example:

```text
cc1101> protocol listen ev1527_like 24 100 375 1
```

Currently supported protocol families are implemented in [`protocol-analysis.js`](/home/lex/projects/node-cc1101/cc1101/analysis/protocol-analysis.js).

### `protocol stop`

Stops the active protocol or analysis runtime.

Example:

```text
cc1101> protocol stop
```

## Frame comparison and stabilization commands

### `consensus start [gdo0] [threshold] [baseUs] [beforeMs] [afterMs]`

Builds a running consensus across recent triggered slices. Useful for repeated key presses from the same remote.

Arguments:

- `gdo0`: GPIO pin, default `24`
- `threshold`: RSSI trigger threshold, default `100`
- `baseUs`: quantization base, default `400`
- `beforeMs`: capture before trigger, default `1000`
- `afterMs`: capture after trigger, default `1000`

Example:

```text
cc1101> consensus start 24 100 400 1000 1000
```

### `stabilize frame [gdo0] [threshold] [baseUs] [lookbackMs]`

Selects the best candidate frame per trigger, compares it to previous best frames, and builds a consensus frame over time.

Arguments:

- `gdo0`: GPIO pin, default `24`
- `threshold`: RSSI trigger threshold, default `100`
- `baseUs`: unit size, default `500`
- `lookbackMs`: history before trigger, default `1000`

Example:

```text
cc1101> stabilize frame 24 100 500 1000
```

### `burst match [gpio] [silenceGapUs] [minEdges] [baseUnitUs]`

Captures raw bursts directly from a GPIO input, normalizes them to units, and compares them to recent bursts.

Arguments:

- `gpio`: GPIO pin, default `24`
- `silenceGapUs`: gap indicating end of burst, default `10000`
- `minEdges`: minimum edges required, default `16`
- `baseUnitUs`: fixed base unit, `0` means auto-estimate

Example:

```text
cc1101> burst match 24 10000 16 0
```

### `canonical build [gpio] [silenceGapUs] [minEdges] [baseUnitUs]`

Builds canonical frames from repeated similar bursts. This is useful when the same transmitter produces slightly noisy variations of the same symbol stream.

Arguments:

- `gpio`: GPIO pin, default `24`
- `silenceGapUs`: end-of-burst gap, default `10000`
- `minEdges`: minimum edges required, default `16`
- `baseUnitUs`: fixed base unit, `0` means auto-estimate

Example:

```text
cc1101> canonical build 24 10000 16 0
```

## Frame extraction

### `frame extract [gdo0] [gdo2] [threshold] [silenceGapUs] [minEdges]`

Extracts a likely frame using:

- `GDO0` async edge data
- `GDO2` PQI hints
- silence-before / silence-after framing

Arguments:

- `gdo0`: GPIO pin for async data, default `24`
- `gdo2`: GPIO pin for PQI, default `25`
- `threshold`: RSSI trigger threshold, default `100`
- `silenceGapUs`: gap treated as frame boundary, default `8000`
- `minEdges`: minimum edge count, default `12`

Example:

```text
cc1101> frame extract 24 25 100 8000 12
```

## Capture and replay

### `capture save [rxDataGpio] [threshold] [baseUs] [beforeMs] [afterMs] [outDir]`

Captures a trigger window and writes it to disk as a JSON capture file.

Arguments:

- `rxDataGpio`: Raspberry Pi input GPIO receiving the CC1101 async data output, default `24`
- `threshold`: RSSI trigger threshold, default `100`
- `baseUs`: quantization base, default `400`
- `beforeMs`: pre-trigger capture window, default `1000`
- `afterMs`: post-trigger capture window, default `1000`
- `outDir`: directory for saved captures, default `/tmp/rf-captures`

Example:

```text
cc1101> capture save 24 100 400 1000 1000 /tmp/rf-captures
```

### `capture show <file>`

Reads a saved capture file and prints a summary.

Example:

```text
cc1101> capture show /tmp/rf-captures/capture-001.json
```

### `capture replay <file> [txDataGpio] [mode] [repeats] [baseUs]`

Loads a capture file and replays it via GPIO.

Arguments:

- `file`: capture JSON path
- `txDataGpio`: Raspberry Pi output GPIO driving the CC1101 async TX data input, default `24`
- `mode`: `normalized` or `raw`, default `normalized`
- `repeats`: number of repeats, default `10`
- `baseUs`: optional override base timing for normalized replay

Example:

```text
cc1101> capture replay /tmp/rf-captures/capture-001.json 24 normalized 10 400
```

Notes:

- Replay timing in Node.js is best-effort and subject to OS jitter.
- Use with caution around real RF devices.

Wiring model:

- Capture path: `CC1101 GDO async-data output -> Raspberry Pi input GPIO (rxDataGpio)`
- Replay path: `Raspberry Pi output GPIO (txDataGpio) -> CC1101 async TX data input`
- These are different directions, even if you choose the same GPIO number in separate test setups.

## Typical workflows

### Packet RX/TX smoke test

```text
cc1101> config set packet 433 ook
cc1101> status
cc1101> listen start 20
cc1101> tx aa 55 01
```

### Find timing for an unknown remote

```text
cc1101> config set direct_async 433 ook
cc1101> signal detect 24 100 1000 220
cc1101> timing fixed 24 100 375 1000
cc1101> segment collect 24 100 375 500
```

### Build a more stable frame from repeated presses

```text
cc1101> stabilize frame 24 100 500 1000
cc1101> consensus start 24 100 400 1000 1000
cc1101> canonical build 24 10000 16 0
```

### Capture and replay a signal

```text
cc1101> capture save 24 100 400 1000 1000 /tmp/rf-captures
cc1101> capture show /tmp/rf-captures/capture-001.json
cc1101> capture replay /tmp/rf-captures/capture-001.json 24 normalized 10 400
```

## Troubleshooting

### Shell starts but cannot connect

Check:

- SPI is enabled on the Pi
- the CC1101 is powered correctly
- bus/device numbers match your wiring
- the process has permission to access SPI and GPIO

### No signals detected

Check:

- antenna and frequency match the transmitter
- `threshold` is not too low or too high
- `gdo0` and `gdo2` pins are correct
- you are using `direct_async` workflows for raw/OOK analysis

### `tx` or `listen start` fails

Those commands require packet mode.

Use:

```text
cc1101> config set packet 433 ook
```

### Replay is inconsistent

That can happen because timing-sensitive replay in Node.js on Linux is not hard real-time. If exact waveform timing matters, you may need a lower-level replay implementation.
