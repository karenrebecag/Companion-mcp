/**
 * The tool list follows Companion: it appears when Companion comes up after the shim, and it
 * changes when Companion reconnects with a different set.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, Server as NetServer, Socket } from 'net';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { BridgeClient, type ToolSpec } from './bridge/client.js';
import { createServer as createMcpServer, attachBridge } from './server.js';

function spec(name: string, description = `${name} tool`): ToolSpec {
  return { name, description, properties: [], required: [] };
}

describe('tool list follows Companion', () => {
  let testDir: string;
  let netServer: NetServer | null;
  let sockets: Socket[];
  let toolSets: ToolSpec[][];

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'companion-tools-'));
    process.env.COMPANION_BRIDGE_DIR = testDir;
    sockets = [];
    toolSets = [];
    netServer = null;
  });

  afterEach(async () => {
    delete process.env.COMPANION_BRIDGE_DIR;
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => (netServer ? netServer.close(() => r()) : r()));
    rmSync(testDir, { recursive: true, force: true });
  });

  // Each connection's hello answers with the next tool set in `toolSets`.
  function startCompanion(): Promise<void> {
    writeFileSync(join(testDir, 'bridge.token'), 'tok', { mode: 0o600 });
    return new Promise((resolve) => {
      netServer = createServer((socket) => {
        sockets.push(socket);
        const tools = toolSets[Math.min(sockets.length, toolSets.length) - 1] ?? [];
        let buffer = '';
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line) continue;
            const msg = JSON.parse(line) as { id: number; method: string };
            const result =
              msg.method === 'hello'
                ? { session: `s${sockets.length}`, language: 'en', accessibility: true, tools }
                : { ok: true, output: 'done', target: '' };
            socket.write(JSON.stringify({ id: msg.id, result }) + '\n');
          }
        });
      });
      netServer.listen(join(testDir, 'bridge.sock'), () => resolve());
    });
  }

  async function connectMcp(bridge: BridgeClient) {
    const server = createMcpServer(bridge);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client({ name: 'test', version: '0' });
    let listChanged = 0;
    mcp.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      listChanged += 1;
    });
    await mcp.connect(clientSide);
    await attachBridge(server, bridge);
    const names = async () => (await mcp.listTools()).tools.map((t) => t.name).sort();
    return { mcp, names, listChanged: () => listChanged };
  }

  function statusText(result: unknown): string {
    const content = (result as { content: Array<{ text: string }> }).content;
    return content.map((c) => c.text).join('\n');
  }

  it('offers the tools once Companion comes up after the shim started', async () => {
    const bridge = new BridgeClient();
    const { mcp, names, listChanged } = await connectMcp(bridge);
    expect(await names()).toEqual(['companion_status']);

    toolSets = [[spec('look'), spec('click')]];
    await startCompanion();
    const status = await mcp.callTool({ name: 'companion_status', arguments: {} });
    expect(statusText(status)).toMatch(/connected/i);
    expect(await names()).toEqual(['click', 'companion_status', 'look']);
    await vi.waitFor(() => expect(listChanged()).toBeGreaterThan(0));
    await bridge.close();
  });

  it('says what to do when Companion is still closed', async () => {
    const bridge = new BridgeClient();
    const { mcp } = await connectMcp(bridge);
    const status = await mcp.callTool({ name: 'companion_status', arguments: {} });
    expect(statusText(status)).toMatch(/open -a Companion/);
  });

  // Companion drops the connection; the next call reconnects, and that hello decides the list.
  async function reconnectWith(bridge: BridgeClient, mcp: Client, call = 'look'): Promise<void> {
    sockets[sockets.length - 1].destroy();
    await vi.waitFor(() => expect(bridge.isConnected).toBe(false));
    await mcp.callTool({ name: call, arguments: {} });
  }

  async function reconnectAndCall(bridge: BridgeClient, mcp: Client): Promise<unknown> {
    sockets[sockets.length - 1].destroy();
    await vi.waitFor(() => expect(bridge.isConnected).toBe(false));
    return mcp.callTool({ name: 'look', arguments: {} });
  }

  it('replaces the tools when Companion reconnects with a different set', async () => {
    toolSets = [
      [spec('look'), spec('click')],
      [spec('look'), spec('see')],
    ];
    await startCompanion();
    const bridge = new BridgeClient();
    const { mcp, names, listChanged } = await connectMcp(bridge);
    expect(await names()).toEqual(['click', 'companion_status', 'look']);

    const before = listChanged();
    await reconnectWith(bridge, mcp);
    expect(await names()).toEqual(['companion_status', 'look', 'see']);
    await vi.waitFor(() => expect(listChanged()).toBeGreaterThan(before));
    await bridge.close();
  });

  it('sends no list change when the set is the same', async () => {
    toolSets = [[spec('look')], [spec('look')]];
    await startCompanion();
    const bridge = new BridgeClient();
    const { mcp, names, listChanged } = await connectMcp(bridge);
    await mcp.callTool({ name: 'look', arguments: {} });
    const before = listChanged();
    await reconnectWith(bridge, mcp);
    await mcp.callTool({ name: 'look', arguments: {} });
    expect(await names()).toEqual(['companion_status', 'look']);
    expect(listChanged()).toBe(before);
    await bridge.close();
  });

  it('keeps only companion_status when Companion comes back with no tools', async () => {
    toolSets = [[spec('look')], []];
    await startCompanion();
    const bridge = new BridgeClient();
    const { mcp, names } = await connectMcp(bridge);
    sockets[0].destroy();
    await vi.waitFor(() => expect(bridge.isConnected).toBe(false));
    await mcp.callTool({ name: 'companion_status', arguments: {} });
    expect(await names()).toEqual(['companion_status']);
    await bridge.close();
  });

  it('shows the new description when a tool keeps its name', async () => {
    toolSets = [[spec('look', 'Look in English')], [spec('look', 'Mira en español')]];
    await startCompanion();
    const bridge = new BridgeClient();
    const { mcp } = await connectMcp(bridge);
    await reconnectWith(bridge, mcp);
    const look = (await mcp.listTools()).tools.find((t) => t.name === 'look');
    expect(look?.description).toMatch(/^Mira en español/);
    await bridge.close();
  });

  it('refuses a tool that the last sync removed', async () => {
    toolSets = [[spec('look'), spec('click')], [spec('look')]];
    await startCompanion();
    const bridge = new BridgeClient();
    const { mcp } = await connectMcp(bridge);
    await reconnectWith(bridge, mcp);
    const outcome = await mcp
      .callTool({ name: 'click', arguments: {} })
      .then((r) => (r as { isError?: boolean }).isError === true)
      .catch(() => true);
    expect(outcome).toBe(true);
    await bridge.close();
  });

  it('registers the rest when one tool from Companion cannot be registered', async () => {
    toolSets = [[spec('companion_status'), spec('look')]];
    await startCompanion();
    const bridge = new BridgeClient();
    const { names } = await connectMcp(bridge);
    expect(await names()).toEqual(['companion_status', 'look']);
    await bridge.close();
  });

  it('never shows the bridge path when the error is not one it knows', async () => {
    const notADir = join(testDir, 'plain-file');
    writeFileSync(notADir, '');
    process.env.COMPANION_BRIDGE_DIR = join(notADir, 'bridge');
    const bridge = new BridgeClient();
    const { mcp } = await connectMcp(bridge);
    const text = statusText(await mcp.callTool({ name: 'companion_status', arguments: {} }));
    expect(text).toMatch(/not reachable/i);
    expect(text).not.toContain(testDir);
  });

  // The action already ran: a failing sync must not turn it into an error the agent retries.
  it('returns the result of a call even when the new tool list is unusable', async () => {
    toolSets = [[spec('look')], 'broken' as unknown as ToolSpec[]];
    await startCompanion();
    const bridge = new BridgeClient();
    const { mcp } = await connectMcp(bridge);
    const result = await reconnectAndCall(bridge, mcp);
    expect((result as { isError?: boolean }).isError).not.toBe(true);
    expect(statusText(result)).toContain('done');
    await bridge.close();
  });
});
