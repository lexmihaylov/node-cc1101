// @ts-check

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
