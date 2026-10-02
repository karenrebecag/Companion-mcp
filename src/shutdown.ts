/**
 * Ends the shim with its MCP client. Without this the process outlives the pipe: the SDK's stdio
 * transport never listens for stdin's end, and the open bridge socket keeps the event loop alive,
 * so a leftover shim holds Companion's only bridge slot and every new session gets busy.
 */
import type { EventEmitter } from 'events';

interface Closable {
  close(): Promise<void>;
}

interface ShutdownDeps {
  input: EventEmitter;
  signals: EventEmitter;
  exit: (code: number) => void;
}

// Above the bye flush cap, so a normal close always finishes first.
const HARD_EXIT_MS = 1_500;

// Built on call, not at import, so importing this module never touches process.stdin.
function defaultDeps(): ShutdownDeps {
  return { input: process.stdin, signals: process, exit: (code) => process.exit(code) };
}

export function installShutdown(client: Closable, deps: ShutdownDeps = defaultDeps()): void {
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // A close that never settles must not keep the process, and Companion's slot, alive.
    setTimeout(() => deps.exit(0), HARD_EXIT_MS).unref();
    // Exiting matters more than a clean bye: a failed close must not leave the process running.
    client
      .close()
      .catch((err: unknown) => {
        process.stderr.write(
          `[shutdown] close failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      })
      .finally(() => deps.exit(0));
  };
  deps.input.on('end', shutdown);
  deps.input.on('close', shutdown);
  deps.signals.on('SIGINT', shutdown);
  deps.signals.on('SIGTERM', shutdown);
}
