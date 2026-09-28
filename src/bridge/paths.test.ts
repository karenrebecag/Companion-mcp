/**
 * Tests for bridge paths resolution.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getSocketPath } from './paths.js';

describe('Bridge paths', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.COMPANION_BRIDGE_DIR;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.COMPANION_BRIDGE_DIR;
    } else {
      process.env.COMPANION_BRIDGE_DIR = originalEnv;
    }
  });

  it('S4: COMPANION_BRIDGE_DIR override logs to stderr', () => {
    const testDir = mkdtempSync(join(tmpdir(), 'bridge-test-'));
    process.env.COMPANION_BRIDGE_DIR = testDir;

    const stderrSpy = vi.spyOn(process.stderr, 'write');

    // Accessing the paths should trigger the log
    getSocketPath();

    // Check that stderr was written to with the override message
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const allLogs = calls.join('');
    expect(allLogs).toContain('[bridge] using COMPANION_BRIDGE_DIR override');

    stderrSpy.mockRestore();
    try {
      rmdirSync(testDir);
    } catch {
      // ignore
    }
  });
});
