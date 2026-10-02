#!/usr/bin/env node
/**
 * stdio entry point.
 *
 * Unlike long-running HTTP servers, this runs locally over stdio: the MCP client
 * spawns this process and talks to it on stdin/stdout. No port, no hosting, no URL
 * secret — the only credential is on-disk, held by the OS file permissions (0600).
 *
 * Connection to Companion is attempted after transport is connected.
 * If Companion is not running or the setting is off, companion_status is the only
 * tool and guides the user to enable it.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BridgeClient } from './bridge/client.js';
import { createServer, attachBridge } from './server.js';
import { installShutdown } from './shutdown.js';

async function main(): Promise<void> {
  const client = new BridgeClient();
  const server = createServer(client);
  installShutdown(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await attachBridge(server, client);
  // Never write to stdout here — it is the MCP channel. Logs go to stderr.
  process.stderr.write('companion-mcp ready on stdio\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
