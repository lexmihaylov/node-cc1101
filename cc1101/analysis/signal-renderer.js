// @ts-check

const COLOR = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  magenta: "\u001b[35m",
};

/**
 * @param {string} color
 * @param {string} value
 * @returns {string}
 */
function paint(color, value) {
  return `${color}${value}${COLOR.reset}`;
}

/**
 * @param {number | null | undefined} unit
 * @returns {string}
 */
function classifyUnit(unit) {
  if (unit === null || unit === undefined) return paint(COLOR.dim, "?");
  if (unit <= 1) return paint(COLOR.green, "S");
  if (unit <= 3) return paint(COLOR.cyan, "M");
  if (unit <= 6) return paint(COLOR.yellow, "L");
  return paint(COLOR.red, "X");
}

/**
 * @param {(number | null | undefined)[]} units
 * @param {number[]=} levels
 * @param {number=} maxSteps
 * @returns {string}
 */
function renderPulseTrack(units, levels = [], maxSteps = 32) {
  const parts = [];

  for (let i = 0; i < Math.min(units.length, maxSteps); i += 1) {
    const rawUnit = units[i];
    const unit = rawUnit === null || rawUnit === undefined ? 1 : Math.max(1, Number(rawUnit));
    const level = Number(levels[i] ?? (i % 2 === 0 ? 1 : 0));
    const width =
      rawUnit === null || rawUnit === undefined ? 1 :
      unit <= 1 ? 1 :
      unit <= 3 ? 1 :
      unit <= 6 ? 2 :
      3;
    const glyph = rawUnit === null || rawUnit === undefined ? "·" : (level ? "▀" : "▄");
    const color =
      rawUnit === null || rawUnit === undefined ? COLOR.dim :
      unit <= 1 ? COLOR.green :
      unit <= 3 ? COLOR.cyan :
      unit <= 6 ? COLOR.yellow :
      COLOR.red;

    parts.push(paint(color, glyph.repeat(width)));
  }

  if (units.length > maxSteps) {
    parts.push(paint(COLOR.dim, "…"));
  }

  return parts.join("");
}

/**
 * @param {(number | null | undefined)[]} units
 * @param {number=} maxItems
 * @returns {string}
 */
function renderUnitClasses(units, maxItems = 32) {
  const values = units.slice(0, maxItems).map((unit) => classifyUnit(unit));
  if (units.length > maxItems) {
    values.push(paint(COLOR.dim, "…"));
  }
  return values.join("");
}

/**
 * @param {(number | null | undefined)[]} values
 * @param {number=} maxItems
 * @returns {string}
 */
function renderNumberRow(values, maxItems = 12) {
  const visible = values.slice(0, maxItems).map((value) => String(value ?? "?").padStart(3, " "));
  if (values.length > maxItems) {
    visible.push("...");
  }
  return visible.join(" ");
}

/**
 * @param {{
 *   units: (number | null | undefined)[],
 *   levels?: number[],
 *   durationsUs?: number[],
 *   snappedUs?: number[],
 *   label?: string,
 *   maxSteps?: number
 * }} options
 * @returns {string[]}
 */
function renderSignalSummary(options) {
  const {
    units,
    levels = [],
    durationsUs = [],
    snappedUs = [],
    label = "signal",
    maxSteps = 32,
  } = options;

  const lines = [
    `${paint(COLOR.magenta, label)} ${paint(COLOR.dim, `steps=${units.length}`)}`,
    `wave:  ${renderPulseTrack(units, levels, maxSteps)}`,
    `class: ${renderUnitClasses(units, maxSteps)}`,
  ];

  if (snappedUs.length) {
    lines.push(`snap:  ${renderNumberRow(snappedUs, 12)}`);
  } else if (durationsUs.length) {
    lines.push(`dt:    ${renderNumberRow(durationsUs, 12)}`);
  }

  lines.push(`unit:  ${renderNumberRow(units, 12)}`);
  return lines;
}

module.exports = {
  renderSignalSummary,
};
