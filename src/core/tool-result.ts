/**
 * Helpers for shaping MCP tool results.
 *
 * The Companion bridge returns results as JSON objects; tools return shaped,
 * agent-friendly text blocks to keep token cost down and output legible.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BridgeError } from '../bridge/errors.js';
import { stripInvisible } from './screen-text.js';
import { withNextAction } from './next-action.js';

// Same ceiling as a server error: enough for a sentence, too short to smuggle a page in.
const MAX_ERROR_MESSAGE = 300;
const ERROR_CODE = /^[a-z_]+$/;

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

// Every error reaches the agent through here, thrown or returned, and its text may come from the
// screen: one line, no invisible characters, bounded, and a code the page cannot invent a shape for.
export function errorResult(code: string, message: string): CallToolResult {
  const safeCode = ERROR_CODE.test(code) ? code : 'tool_failed';
  // Cut by code point: a UTF-16 slice can leave half an emoji at the end.
  const flat = Array.from(stripInvisible(message).replace(/\s+/g, ' '))
    .slice(0, MAX_ERROR_MESSAGE)
    .join('');
  // After the cap: the hint is our text, not the screen's, and cutting it would lose the action.
  return {
    content: [{ type: 'text', text: `error[${safeCode}]: ${withNextAction(safeCode, flat)}` }],
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
