/**
 * Resolves the path to Companion's bridge socket and token file.
 *
 * Default: ~/Library/Application Support/Companion/bridge/{bridge.sock,bridge.token}
 * Override: COMPANION_BRIDGE_DIR env points to the directory containing both files.
 */
import { homedir } from 'os';
import { join } from 'path';

let logged = false;

function getBridgeDir(): string {
  if (process.env.COMPANION_BRIDGE_DIR) {
    // Log the override once per process (S4).
    if (!logged) {
      process.stderr.write('[bridge] using COMPANION_BRIDGE_DIR override\n');
      logged = true;
    }
    return process.env.COMPANION_BRIDGE_DIR;
  }
  return join(homedir(), 'Library', 'Application Support', 'Companion', 'bridge');
}

export function getSocketPath(): string {
  return join(getBridgeDir(), 'bridge.sock');
}

export function getTokenPath(): string {
  return join(getBridgeDir(), 'bridge.token');
}
