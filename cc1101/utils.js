// @ts-check

/**
 * @typedef {Record<string, string | boolean>} ParsedArgs
 */

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {number[]} bytes
 * @returns {string}
 */
function hex(bytes) {
  return bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

/**
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
function parseArgs(argv) {
  /** @type {ParsedArgs} */
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];

    if (!key.startsWith("--")) continue;

    const name = key.slice(2);
    if (!next || next.startsWith("--")) {
      args[name] = true;
      continue;
    }

    args[name] = next;
    i += 1;
  }
  return args;
}

/**
 * @param {string | undefined} input
 * @returns {number[]}
 */
function parsePayload(input) {
  if (!input) return [0xaa, 0x55, 0xaa, 0x55, 0x01];

  const cleaned = input.replace(/,/g, " ").trim();
  if (!cleaned) return [0xaa, 0x55, 0xaa, 0x55, 0x01];

  return cleaned.split(/\s+/).map((part) => {
    const normalized = part.startsWith("0x") ? part.slice(2) : part;
    const value = Number.parseInt(normalized, 16);
    if (Number.isNaN(value) || value < 0 || value > 255) {
      throw new Error(`Invalid payload byte: ${part}`);
    }
    return value;
  });
}

module.exports = {
  sleep,
  hex,
  parseArgs,
  parsePayload,
};
