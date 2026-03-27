// @ts-check

/**
 * @param {number | null} lastAcceptedTriggerRssi
 * @param {number | null} triggerRssi
 * @param {number | null} rssiTolerance
 * @returns {boolean}
 */
function shouldAcceptTriggerRssi(lastAcceptedTriggerRssi, triggerRssi, rssiTolerance) {
  return (
    rssiTolerance === null ||
    lastAcceptedTriggerRssi === null ||
    Math.abs(lastAcceptedTriggerRssi - triggerRssi) <= rssiTolerance
  );
}

module.exports = {
  shouldAcceptTriggerRssi,
};
