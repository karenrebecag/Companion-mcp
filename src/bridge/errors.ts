/**
 * Bridge protocol errors.
 */
export class BridgeError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}
