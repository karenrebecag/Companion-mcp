/**
 * Bridge protocol errors.
 */
export class BridgeError extends Error {
  constructor(
    public code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BridgeError';
  }
}
