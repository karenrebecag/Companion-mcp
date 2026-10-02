/**
 * The shim must not outlive its MCP client: a leftover process keeps Companion's only bridge slot.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { installShutdown } from './shutdown.js';

function rig() {
  const input = new EventEmitter();
  const signals = new EventEmitter();
  const close = vi.fn(async () => undefined);
  const exit = vi.fn();
  installShutdown({ close }, { input, signals, exit });
  const settled = () => new Promise((r) => setImmediate(r));
  return { input, signals, close, exit, settled };
}

describe('installShutdown', () => {
  it.each(['end', 'close'])('closes the bridge and exits when stdin emits %s', async (event) => {
    const { input, close, exit, settled } = rig();
    input.emit(event);
    await settled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it.each(['SIGINT', 'SIGTERM'])('closes the bridge and exits on %s', async (signal) => {
    const { signals, close, exit, settled } = rig();
    signals.emit(signal);
    await settled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('closes once when several shutdown events arrive together', async () => {
    const { input, signals, close, exit, settled } = rig();
    input.emit('end');
    input.emit('close');
    signals.emit('SIGTERM');
    await settled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('still exits when closing the bridge fails', async () => {
    const input = new EventEmitter();
    const exit = vi.fn();
    installShutdown(
      { close: async () => Promise.reject(new Error('boom')) },
      { input, signals: new EventEmitter(), exit },
    );
    input.emit('end');
    await new Promise((r) => setImmediate(r));
    expect(exit).toHaveBeenCalledWith(0);
  });

  // A close that never settles must not keep the process, and the slot, alive.
  it('exits anyway when closing the bridge hangs', async () => {
    vi.useFakeTimers();
    try {
      const input = new EventEmitter();
      const exit = vi.fn();
      installShutdown(
        { close: () => new Promise<void>(() => undefined) },
        { input, signals: new EventEmitter(), exit },
      );
      input.emit('end');
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
