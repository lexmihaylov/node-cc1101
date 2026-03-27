#!/usr/bin/env node
// @ts-check

const readline = require("readline");
const appConfig = require("./config");
const { CC1101Driver } = require("./cc1101/driver");
const { PACKET_LENGTH_MODE } = require("./cc1101/profiles");
const { parseArgs, sleep } = require("./cc1101/utils");
const { createCommandRegistry } = require("./commands");
const { createDefaultRadioConfig } = require("./commands/helpers");

/**
 * @typedef {import("./commands/types").CommandRegistry} CommandRegistry
 */

const COLOR = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  blue: "\u001b[34m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  magenta: "\u001b[35m",
};

function parseLine(line) {
  const tokens = [];
  const matches = line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];

  for (const match of matches) {
    if (
      (match.startsWith("\"") && match.endsWith("\"")) ||
      (match.startsWith("'") && match.endsWith("'"))
    ) {
      tokens.push(match.slice(1, -1));
    } else {
      tokens.push(match);
    }
  }

  return tokens;
}

class RadioShell {
  /**
   * @param {{
   *   bus?: number,
   *   device?: number,
   *   speedHz?: number,
   *   commandRegistry?: CommandRegistry,
   *   clearTerminal?: () => void,
   *   renderFrame?: (frame: string) => void,
   * }=} options
   */
  constructor(options = {}) {
    this.bus = options.bus ?? appConfig.spi.bus;
    this.device = options.device ?? appConfig.spi.device;
    this.speedHz = options.speedHz ?? appConfig.spi.speedHz;
    this.commandRegistry = options.commandRegistry ?? createCommandRegistry();
    this.radio = null;
    this.listening = false;
    this.runtime = null;
    this.radioConfig = createDefaultRadioConfig();
    this.clearTerminal = options.clearTerminal ?? (() => {
      process.stdout.write("\u001bc");
    });
    this.renderFrame = options.renderFrame ?? ((frame) => {
      process.stdout.write(frame);
    });
  }

  async ensureConnected() {
    if (this.radio) return;
    await this.connect(this.bus, this.device, this.speedHz);
  }

  async connect(bus = this.bus, device = this.device, speedHz = this.speedHz) {
    if (this.radio) {
      await this.disconnect();
    }

    this.bus = Number(bus);
    this.device = Number(device);
    this.speedHz = Number(speedHz);
    this.radio = new CC1101Driver({
      bus: this.bus,
      device: this.device,
      speedHz: this.speedHz,
    });

    await this.radio.open();
    await this.radio.reset();
    const info = await this.radio.verifyChip();
    console.log(
      `connected bus=${this.bus} device=${this.device} speed=${this.speedHz} part=0x${info.partnum
        .toString(16)
        .padStart(2, "0")} version=0x${info.version.toString(16).padStart(2, "0")}`
    );
  }

  async stop() {
    if (this.listening) {
      this.listening = false;
      await sleep(5);
      if (this.radio) {
        await this.radio.idle().catch(() => {});
      }
    }

    if (this.runtime) {
      const runtime = this.runtime;
      this.runtime = null;
      await runtime.stop();
      console.log("runtime stopped");
    }
  }

  async disconnect() {
    await this.stop();

    if (!this.radio) return;

    try {
      await this.radio.idle();
    } catch {}

    await this.radio.close().catch(() => {});
    this.radio = null;
  }
}

/**
 * @param {RadioShell} shell
 * @param {string} line
 * @param {() => void} onExit
 * @returns {Promise<void>}
 */
async function executeCommand(shell, line, onExit) {
  const tokens = parseLine(line.trim());
  if (!tokens.length) return;

  const [commandName, ...args] = tokens;
  const command = shell.commandRegistry.findCommand(commandName);

  if (!command) {
    console.log("unknown command; type `help` or `man`");
    return;
  }

  const context = {
    shell,
    args,
    onExit,
    registry: shell.commandRegistry,
    commandName,
  };

  if (command.runInBackground) {
    void Promise.resolve(command.execute(context)).catch((error) => {
      console.error(`${command.name} failed: ${error.message}`);
    });
    return;
  }

  await command.execute(context);
}

function colorizeStatus(shell) {
  const config = shell.radioConfig;
  const transport = shell.radio ? `${COLOR.green}connected${COLOR.reset}` : `${COLOR.yellow}disconnected${COLOR.reset}`;
  const runtime = shell.listening
    ? `${COLOR.magenta}listen${COLOR.reset}`
    : shell.runtime
      ? `${COLOR.magenta}runtime${COLOR.reset}`
      : `${COLOR.dim}idle${COLOR.reset}`;

  return [
    `${COLOR.cyan}CC1101${COLOR.reset} ${COLOR.dim}| Ctrl+C interrupts | exit closes shell${COLOR.reset}`,
    `${COLOR.blue}link${COLOR.reset}=${transport}  ` +
      `${COLOR.blue}bus${COLOR.reset}=${shell.bus}  ` +
      `${COLOR.blue}dev${COLOR.reset}=${shell.device}  ` +
      `${COLOR.blue}speed${COLOR.reset}=${shell.speedHz}  ` +
      `${COLOR.blue}mode${COLOR.reset}=${config.mode}  ` +
      `${COLOR.blue}band${COLOR.reset}=${config.band}  ` +
      `${COLOR.blue}mod${COLOR.reset}=${config.modulation}  ` +
      `${COLOR.blue}state${COLOR.reset}=${runtime}`,
  ].join("\n");
}

function buildPrompt(shell) {
  return `${colorizeStatus(shell)}\n${COLOR.cyan}cc1101>${COLOR.reset} `;
}

async function main() {
  const args = parseArgs(process.argv);
  const bus = Number(args.bus ?? appConfig.spi.bus);
  const device = Number(args.device ?? appConfig.spi.device);
  const speedHz = Number(args.speed ?? appConfig.spi.speedHz);
  const shell = new RadioShell({
    bus,
    device,
    speedHz,
    commandRegistry: createCommandRegistry(),
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 200,
  });

  let shuttingDown = false;
  let interrupting = false;

  const prompt = () => {
    if (shuttingDown) return;
    rl.setPrompt(buildPrompt(shell));
    rl.prompt();
  };

  const closeShell = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shell.disconnect().catch(() => {});
    process.exit(0);
  };

  const handleInterrupt = async () => {
    if (interrupting || shuttingDown) return;
    interrupting = true;

    try {
      const hadActiveRuntime = shell.listening || Boolean(shell.runtime);
      await shell.stop();

      if (!hadActiveRuntime) {
        console.log("interrupt ignored; no active runtime");
      }
    } finally {
      interrupting = false;
      prompt();
    }
  };

  process.on("SIGINT", () => {
    void handleInterrupt();
  });

  process.on("SIGTERM", () => {
    void closeShell();
  });

  rl.on("line", async (value) => {
    const line = value.trim();
    try {
      await executeCommand(shell, line, () => void closeShell());
    } catch (error) {
      console.error(error.message);
    } finally {
      prompt();
    }
  });

  rl.on("SIGINT", () => {
    void handleInterrupt();
  });

  rl.on("close", () => {
    if (!shuttingDown) {
      void closeShell();
    }
  });

  try {
    await shell.connect();
    console.log("interactive shell ready");
  } catch (error) {
    console.error(`startup failed: ${error.message}`);
  }

  prompt();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { RadioShell, executeCommand };
