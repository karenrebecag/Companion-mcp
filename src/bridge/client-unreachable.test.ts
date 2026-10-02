/**
 * The socket's own failure codes, fed in directly: a stale socket after a crash (ECONNREFUSED)
 * cannot be reproduced reliably on disk, and each platform reports a leftover file differently.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createConnection, Socket } from 'net';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BridgeClient } from './client.js';

vi.mock('net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('net')>();
  return { ...actual, createConnection: vi.fn(actual.createConnection) };
});

function failingSocket(err: Error): Socket {
  const socket = new Socket();
  setImmediate(() => socket.emit('error', err));
  return socket;
}

// The message names no code, so a match on message text instead of err.code would fail here.
const withCode = (code: string): Error => Object.assign(new Error('boom'), { code });

describe('BridgeClient translates socket failures by code', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'companion-stub-'));
    process.env.COMPANION_BRIDGE_DIR = testDir;
    writeFileSync(join(testDir, 'bridge.token'), 'stub-token-value');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.COMPANION_BRIDGE_DIR;
    unlinkSync(join(testDir, 'bridge.token'));
    rmdirSync(testDir);
  });

  it.each([
    ['ECONNREFUSED', 'companion_unavailable'],
    ['ENOTSOCK', 'companion_unavailable'],
    ['ENOENT', 'companion_unavailable'],
    ['EACCES', 'permission_required'],
  ])('%s becomes %s, keeps its cause and logs only the code', async (errno, code) => {
    const raw = withCode(errno);
    vi.mocked(createConnection).mockImplementationOnce(() => failingSocket(raw));
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    const err = await new BridgeClient().connect().catch((e: unknown) => e);

    expect(err).toMatchObject({ name: 'BridgeError', code });
    expect((err as Error).cause).toBe(raw);
    expect(writes.join('')).toContain(errno);
    expect(writes.join('')).not.toContain(testDir);
    expect(writes.join('')).not.toContain('stub-token-value');
  });

  it('passes an unlisted socket code through untouched', async () => {
    const raw = withCode('ETIMEDOUT');
    vi.mocked(createConnection).mockImplementationOnce(() => failingSocket(raw));

    await expect(new BridgeClient().connect()).rejects.toBe(raw);
  });
});
