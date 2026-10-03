/**
 * Tests for tool result helpers.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BridgeClient } from '../bridge/client.js';
import { BridgeError } from '../bridge/errors.js';
import { textResult, errorResult, runTool } from './tool-result.js';

describe('tool result helpers', () => {
  it('textResult returns text content', () => {
    const result = textResult('Hello, world!');
    expect(result.content).toHaveLength(1);
    const block = result.content[0];
    expect(block.type).toBe('text');
    expect(block.type === 'text' && block.text).toBe('Hello, world!');
    expect(result.isError).toBeUndefined();
  });

  it('errorResult formats error[code]: message', () => {
    const result = errorResult('stale_id', 'Element ID expired');
    expect(result.content).toHaveLength(1);
    const block = result.content[0];
    expect(block.type === 'text' && block.text).toBe('error[stale_id]: Element ID expired');
    expect(result.isError).toBe(true);
  });

  it('runTool catches errors and returns errorResult', async () => {
    const result = await runTool(async () => {
      throw new Error('Something went wrong');
    });
    expect(result.isError).toBe(true);
    const block = result.content[0];
    expect(block.type === 'text' && block.text).toContain('error[tool_failed]');
    expect(block.type === 'text' && block.text).toContain('Something went wrong');
  });

  it('runTool preserves BridgeError code', async () => {
    const result = await runTool(async () => {
      throw new BridgeError('stale_id', 'Element ID expired');
    });
    expect(result.isError).toBe(true);
    const block = result.content[0];
    expect(block.type === 'text' && block.text).toContain('error[stale_id]');
    expect(block.type === 'text' && block.text).toContain('Element ID expired');
  });

  it('a closed Companion reaches the model as companion_unavailable, not tool_failed', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'companion-closed-'));
    process.env.COMPANION_BRIDGE_DIR = emptyDir;
    let result;
    try {
      result = await runTool(async () => {
        await new BridgeClient().call('look', {});
        return textResult('unreachable');
      });
    } finally {
      delete process.env.COMPANION_BRIDGE_DIR;
      rmdirSync(emptyDir);
    }
    expect(result.isError).toBe(true);
    const block = result.content[0];
    expect(block.type === 'text' && block.text).toMatch(
      /^error\[companion_unavailable\]: Companion is not running/,
    );
  });

  it('runTool returns success result when fn succeeds', async () => {
    const result = await runTool(async () => textResult('Success!'));
    expect(result.isError).toBeUndefined();
    const block = result.content[0];
    expect(block.type === 'text' && block.text).toBe('Success!');
  });
});

// Thrown errors skip handleCallResult; the cleaning lives where every error passes.
describe('errorResult cleaning', () => {
  const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

  it('strips, flattens and caps the message at 300 characters, and refuses a malformed code', () => {
    const out = text(errorResult('Not A Code', `a\u{E0049}b\nc ${'x'.repeat(1000)}`));
    expect(out.startsWith('error[tool_failed]: ab c ')).toBe(true);
    expect(out.length - 'error[tool_failed]: '.length).toBe(300);
  });

  it('never cuts an astral character in half at the cap', () => {
    const out = text(errorResult('x', `${'a'.repeat(299)}\u{1F600}tail`));
    expect(out).toBe(`error[x]: ${'a'.repeat(299)}\u{1F600}`);
  });

  it.each([
    [new BridgeError('stale_id', 'a\u{E0049}b\nc'), 'error[stale_id]: ab c'],
    [new Error('a\u{200B}b'), 'error[tool_failed]: ab'],
    ['raw\u{202E} string', 'error[tool_failed]: raw string'],
  ])('cleans what runTool catches: %s', async (thrown, expected) => {
    const out = await runTool(async () => {
      throw thrown;
    });
    expect(text(out)).toBe(expected);
  });
});
