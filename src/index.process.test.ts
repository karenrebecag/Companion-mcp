/**
 * The real entry point, as Claude Code runs it: when its stdin ends, the process must exit and
 * Companion must hear bye. Injected fakes cannot show this; the bug was in the SDK's transport.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { createServer, Server as NetServer } from 'net';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx');
const ENTRY = join(process.cwd(), 'src', 'index.ts');

describe('companion-mcp process', () => {
  let testDir: string;
  let server: NetServer;
  let seen: string[];

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'companion-proc-'));
    writeFileSync(join(testDir, 'bridge.token'), 'tok', { mode: 0o600 });
    seen = [];
    server = createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line) continue;
          const msg = JSON.parse(line) as { id: number; method: string };
          seen.push(msg.method);
          if (msg.method === 'hello') {
            const result = { session: 's', language: 'en', accessibility: true, tools: [] };
            socket.write(JSON.stringify({ id: msg.id, result }) + '\n');
          }
        }
      });
      socket.on('close', () => seen.push('closed'));
    });
    await new Promise<void>((r) => server.listen(join(testDir, 'bridge.sock'), () => r()));
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(testDir, { recursive: true, force: true });
  });

  it('exits and says bye when its stdin ends', async () => {
    const child = spawn(TSX, [ENTRY], {
      env: { ...process.env, COMPANION_BRIDGE_DIR: testDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`never ready: ${stderr}`)), 10_000);
      child.stderr.on('data', () => {
        if (stderr.includes('ready on stdio')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    expect(seen).toContain('hello');

    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', (code) => resolve(code)),
    );
    child.stdin.end();
    const code = await Promise.race([
      exited,
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 5_000)),
    ]);
    if (code === 'hung') child.kill('SIGKILL');
    expect(code).toBe(0);
    expect(seen).toEqual(['hello', 'bye', 'closed']);
  }, 20_000);
});
