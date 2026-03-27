#!/usr/bin/env node
// @ts-check

const util = require("util");
const blessed = require("@blessed/neo-blessed");
const appConfig = require("./config");
const { parseArgs } = require("./cc1101/utils");
const { createCommandRegistry } = require("./commands");
const { RadioShell, executeCommand } = require("./radio-shell");

/**
 * @param {blessed.Widgets.Log} logBox
 * @param {string} text
 * @returns {void}
 */
function appendLog(logBox, text) {
  const lines = String(text).replace(/\r/g, "").split("\n");
  for (const line of lines) {
    logBox.add(line);
  }
}

/**
 * @param {RadioShell} shell
 * @returns {string}
 */
function formatStatus(shell) {
  const transport = shell.radio ? "connected" : "disconnected";
  const runtime = shell.listening ? "listen" : shell.runtime ? "runtime" : "idle";
  return [
    `link=${transport}`,
    `bus=${shell.bus}`,
    `dev=${shell.device}`,
    `speed=${shell.speedHz}`,
    `mode=${shell.radioConfig.mode}`,
    `band=${shell.radioConfig.band}`,
    `mod=${shell.radioConfig.modulation}`,
    `state=${runtime}`,
  ].join("  ");
}

async function main() {
  const args = parseArgs(process.argv);
  const bus = Number(args.bus ?? appConfig.spi.bus);
  const device = Number(args.device ?? appConfig.spi.device);
  const speedHz = Number(args.speed ?? appConfig.spi.speedHz);

  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    title: "CC1101 TUI",
    dockBorders: true,
  });

  const statusBar = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 2,
    tags: false,
    style: {
      fg: "white",
      bg: "blue",
    },
  });

  const outputBox = blessed.log({
    parent: screen,
    top: 2,
    left: 0,
    width: "70%",
    bottom: 3,
    label: " Output ",
    border: "line",
    tags: false,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: true,
    scrollbar: {
      ch: " ",
      inverse: true,
    },
  });

  const previewBox = blessed.box({
    parent: screen,
    top: 2,
    left: "70%",
    width: "30%",
    bottom: 3,
    label: " Preview ",
    border: "line",
    tags: false,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: true,
    content: "No preview",
  });

  const inputBox = blessed.textbox({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 3,
    label: " Command ",
    border: "line",
    inputOnFocus: true,
    keys: true,
    mouse: true,
  });

  const shell = new RadioShell({
    bus,
    device,
    speedHz,
    commandRegistry: createCommandRegistry(),
    clearTerminal: () => {
      outputBox.setContent("");
      previewBox.setContent("No preview");
      screen.render();
    },
    renderFrame: (frame) => {
      previewBox.setContent(String(frame).replace(/\u001b\[[0-9;]*[A-Za-z]/g, ""));
      previewBox.setScrollPerc(100);
      screen.render();
    },
  });

  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;

  console.log = (...values) => {
    appendLog(outputBox, util.format(...values));
    screen.render();
  };

  console.error = (...values) => {
    appendLog(outputBox, `[error] ${util.format(...values)}`);
    screen.render();
  };

  let statusTimer = null;
  let shuttingDown = false;

  const refreshStatus = () => {
    statusBar.setContent(` ${formatStatus(shell)} `);
    screen.render();
  };

  const closeTui = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }

    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    await shell.disconnect().catch(() => {});
    screen.destroy();
    process.exit(0);
  };

  screen.key(["C-c"], () => {
    void shell.stop().then(() => {
      refreshStatus();
    });
  });

  screen.key(["q"], () => {
    void closeTui();
  });

  inputBox.on("submit", (value) => {
    const line = String(value).trim();
    inputBox.clearValue();
    inputBox.focus();

    if (!line) {
      screen.render();
      return;
    }

    appendLog(outputBox, `> ${line}`);
    screen.render();

    void executeCommand(shell, line, () => void closeTui())
      .catch((error) => {
        appendLog(outputBox, `[error] ${error.message}`);
      })
      .finally(() => {
        refreshStatus();
        inputBox.focus();
      });
  });

  screen.on("resize", () => {
    screen.render();
  });

  try {
    await shell.connect();
    appendLog(outputBox, "interactive TUI ready");
  } catch (error) {
    appendLog(outputBox, `startup failed: ${error.message}`);
  }

  statusTimer = setInterval(refreshStatus, 250);
  refreshStatus();
  inputBox.focus();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
