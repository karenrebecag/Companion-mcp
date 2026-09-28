/**
 * Helpers for shaping MCP tool results.
 *
 * The Companion bridge returns results as JSON objects; tools return shaped,
 * agent-friendly text blocks to keep token cost down and output legible.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BridgeError } from '../bridge/errors.js';

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(code: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `error[${code}]: ${message}` }],
    isError: true,
  };
}

/**
 * Wrap a tool handler so a thrown error becomes a clean MCP error
 * result instead of crashing the transport. Every tool routes through this.
 */
export async function runTool(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BridgeError) {
      return errorResult(err.code, err.message);
    }
    return errorResult('tool_failed', err instanceof Error ? err.message : String(err));
  }
}
