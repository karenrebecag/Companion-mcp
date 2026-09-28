/**
 * Tests for tool result helpers.
 */
import { describe, it, expect } from 'vitest';
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

  it('runTool returns success result when fn succeeds', async () => {
    const result = await runTool(async () => textResult('Success!'));
    expect(result.isError).toBeUndefined();
    const block = result.content[0];
    expect(block.type === 'text' && block.text).toBe('Success!');
  });
});
