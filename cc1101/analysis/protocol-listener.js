// @ts-check

const { CC1101ProtocolDetector } = require("./protocol-detector");
const { renderSignalSummary } = require("./signal-renderer");
const {
  compactFrame,
  decodeByProtocol,
} = require("./protocol-analysis");

/**
 * @typedef {import("./protocol-detector").ProtocolDetectorOptions} ProtocolDetectorOptions
 * @typedef {import("./protocol-detector").ProtocolPress} ProtocolPress
 * @typedef {import("./protocol-analysis").ProtocolCandidate} ProtocolCandidate
 * @typedef {import("./protocol-analysis").DecodedProtocolResult} DecodedProtocolResult
 *
 * @typedef {object} ProtocolListenerOptions
 * @property {string=} protocol
 * @property {number=} tolerance
 * @property {(message: string) => void=} onMessage
 * @property {(press: ProtocolPress, candidate: ProtocolCandidate, decoded: DecodedProtocolResult) => void=} onDecoded
 *
 * @typedef {ProtocolDetectorOptions & ProtocolListenerOptions} FullProtocolListenerOptions
 */

class CC1101ProtocolListener {
  /**
   * @param {FullProtocolListenerOptions=} options
   */
  constructor(options = {}) {
    this.options = {
      protocol: options.protocol ?? "ev1527_like",
      tolerance: options.tolerance ?? 1,
      onMessage: options.onMessage ?? ((message) => console.log(message)),
      onDecoded: options.onDecoded ?? ((press, candidate, decoded) => {
        const units = candidate.frame.map((edge) => edge.units);
        this.options.onMessage("---- protocol listen ----");
        this.options.onMessage(`press:        ${press.id}`);
        this.options.onMessage(`ts:           ${press.ts}`);
        this.options.onMessage(`triggerRSSI:  ${press.triggerRssi}`);
        this.options.onMessage(`protocol:     ${decoded.protocol}`);
        this.options.onMessage(`confidence:   ${(decoded.confidence * 100).toFixed(1)}%`);
        this.options.onMessage(`frameScore:   ${candidate.frameScore}`);
        this.options.onMessage(`edges:        ${candidate.frame.length}`);
        this.options.onMessage(`units:        ${units.join(",")}`);
        this.options.onMessage(`compact:      ${compactFrame(candidate.frame)}`);
        for (const line of renderSignalSummary({
          label: "decoded",
          units,
          levels: candidate.frame.map((edge) => edge.level),
          durationsUs: candidate.frame.map((edge) => edge.dtUs),
          snappedUs: candidate.frame.map((edge) => edge.snappedUs),
        })) {
          this.options.onMessage(line);
        }
        this.options.onMessage(`bits:         ${decoded.bits}`);
        this.options.onMessage(`cleanBits:    ${decoded.cleanBits}`);
        this.options.onMessage(`details:      ${decoded.details}`);
        if (decoded.fields) {
          this.options.onMessage(`fields:       ${JSON.stringify(decoded.fields)}`);
        }
        this.options.onMessage("");
      }),
    };

    this.detector = new CC1101ProtocolDetector({
      ...options,
      maxFrames: 1,
      onMessage: this.options.onMessage,
      onCandidate: (press, candidate) => {
        const decoded = decodeByProtocol(
          this.options.protocol,
          candidate.frame,
          this.options.tolerance
        );
        this.options.onDecoded(press, candidate, decoded);
      },
    });
  }

  async start() {
    await this.detector.start();
  }

  async stop() {
    await this.detector.stop();
  }
}

module.exports = {
  CC1101ProtocolListener,
};
