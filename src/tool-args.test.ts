/**
 * Tool arguments are checked at the edge, before anything reaches Companion.
 */
import { describe, it, expect } from 'vitest';
import { buildSchemaForTool, MAX_STRING_BYTES } from './tool-args.js';
import type { ToolSpec } from './bridge/client.js';

const typeText: ToolSpec = {
  name: 'type_text',
  description: 'type',
  properties: [{ name: 'text', type: 'string', description: 'what to type' }],
  required: ['text'],
};

const issues = (schema: ReturnType<typeof buildSchemaForTool>, value: unknown) => {
  const parsed = schema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
};

describe('tool arguments', () => {
  it('a misspelled argument is refused instead of dropped', () => {
    const schema = buildSchemaForTool(typeText);
    expect(schema.safeParse({ text: 'hi' }).success).toBe(true);
    expect(schema.safeParse({ text: 'hi', txet: 'hi' }).success).toBe(false);
  });

  it('a string is capped in UTF-8 bytes, not characters', () => {
    const schema = buildSchemaForTool(typeText);
    expect(schema.safeParse({ text: 'a'.repeat(MAX_STRING_BYTES) }).success).toBe(true);
    expect(schema.safeParse({ text: 'a'.repeat(MAX_STRING_BYTES + 1) }).success).toBe(false);
    // Each of these is three bytes: a third of the characters already fills the cap.
    const wide = '€'.repeat(Math.floor(MAX_STRING_BYTES / 3) + 1);
    expect(issues(schema, { text: wide }).join(' ')).toContain(`${MAX_STRING_BYTES} UTF-8 bytes`);
  });

  it('a NUL is refused', () => {
    expect(issues(buildSchemaForTool(typeText), { text: 'a\u0000b' }).join(' ')).toContain('NUL');
  });

  it('an enum Companion declares is enforced and named in the error', () => {
    const scroll: ToolSpec = {
      name: 'scroll',
      description: 'scroll',
      properties: [
        { name: 'direction', type: 'string', description: 'up | down', enum: ['up', 'down'] },
      ],
      required: ['direction'],
    };
    const schema = buildSchemaForTool(scroll);
    expect(schema.safeParse({ direction: 'up' }).success).toBe(true);
    const message = issues(schema, { direction: 'left' }).join(' ');
    expect(message).toContain('up');
    expect(message).toContain('down');
  });

  it('declared minLength and maxBytes are enforced', () => {
    const spec: ToolSpec = {
      name: 'open_url',
      description: 'open',
      properties: [{ name: 'url', type: 'string', description: 'url', minLength: 1, maxBytes: 10 }],
      required: ['url'],
    };
    const schema = buildSchemaForTool(spec);
    expect(schema.safeParse({ url: '' }).success).toBe(false);
    expect(schema.safeParse({ url: 'https://x' }).success).toBe(true);
    expect(schema.safeParse({ url: 'https://xyz' }).success).toBe(false);
  });

  it('a declared maxBytes above the shim ceiling cannot raise it', () => {
    const spec: ToolSpec = {
      name: 'type_text',
      description: 'type',
      properties: [
        { name: 'text', type: 'string', description: 't', maxBytes: MAX_STRING_BYTES * 10 },
      ],
      required: ['text'],
    };
    expect(
      buildSchemaForTool(spec).safeParse({ text: 'a'.repeat(MAX_STRING_BYTES + 1) }).success,
    ).toBe(false);
  });

  // Each probe is a value the malformed constraint would refuse if it were trusted.
  it.each([
    ['enum []', { enum: [] }, 'zzz'],
    ['enum with a non-string', { enum: ['a', 1] }, 'zzz'],
    ['enum as a string', { enum: 'up' }, 'zzz'],
    ['minLength as a string', { minLength: '3' }, ''],
    ['minLength fractional', { minLength: 1.5 }, ''],
    ['minLength infinite', { minLength: Infinity }, 'ab'],
    ['maxBytes negative', { maxBytes: -1 }, 'ab'],
    ['maxBytes fractional', { maxBytes: 1.5 }, 'ab'],
    ['maxBytes as a string', { maxBytes: '1' }, 'ab'],
  ])('a malformed constraint from the hello is ignored: %s', (_label, constraint, probe) => {
    const spec = {
      name: 't',
      description: 't',
      properties: [{ name: 'a', type: 'string', description: 'a', ...constraint }],
      required: ['a'],
    } as unknown as ToolSpec;
    expect(buildSchemaForTool(spec).safeParse({ a: probe }).success).toBe(true);
  });

  it('a valid constraint still holds when its neighbour is malformed', () => {
    const spec = {
      name: 't',
      description: 't',
      properties: [{ name: 'a', type: 'string', description: 'a', minLength: 2, maxBytes: 'big' }],
      required: ['a'],
    } as unknown as ToolSpec;
    const schema = buildSchemaForTool(spec);
    expect(schema.safeParse({ a: 'a' }).success).toBe(false);
    expect(schema.safeParse({ a: 'ab' }).success).toBe(true);
  });

  it('numbers, integers and booleans keep their types', () => {
    const spec: ToolSpec = {
      name: 'click',
      description: 'click',
      properties: [
        { name: 'id', type: 'integer', description: 'id' },
        { name: 'x', type: 'number', description: 'x' },
        { name: 'double', type: 'boolean', description: 'd' },
      ],
      required: ['id'],
    };
    const schema = buildSchemaForTool(spec);
    expect(schema.safeParse({ id: 3, x: 1.5, double: true }).success).toBe(true);
    expect(schema.safeParse({ id: 3.5 }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  // Enum values reach the agent in the schema and in every validation error: a hostile or
  // oversized list is ignored, which leaves the plain capped string and Companion's own check.
  it.each([
    ['too many values', Array.from({ length: 51 }, (_, i) => `v${i}`)],
    ['a value too long', ['up', 'x'.repeat(65)]],
    ['a control character', ['up', 'do\nwn']],
    ['an invisible character', ['up', 'do\u200Bwn']],
    ['an empty value', ['up', '']],
    ['a DEL character', ['up', 'a\x7Fb']],
    ['a line separator', ['up', 'a\u2028b']],
    ['a non-string member', ['up', 7]],
  ])('an enum with %s is ignored', (_label, values) => {
    const spec = {
      name: 't',
      description: 't',
      properties: [{ name: 'a', type: 'string', description: 'a', enum: values }],
      required: ['a'],
    } as unknown as ToolSpec;
    expect(buildSchemaForTool(spec).safeParse({ a: 'zzz' }).success).toBe(true);
  });

  it('an enum within the caps is still enforced', () => {
    const values = [...Array.from({ length: 49 }, (_, i) => `v${i}`), 'x'.repeat(64)];
    const spec = {
      name: 't',
      description: 't',
      properties: [{ name: 'a', type: 'string', description: 'a', enum: values }],
      required: ['a'],
    } as unknown as ToolSpec;
    expect(buildSchemaForTool(spec).safeParse({ a: 'zzz' }).success).toBe(false);
    expect(buildSchemaForTool(spec).safeParse({ a: 'v48' }).success).toBe(true);
    expect(buildSchemaForTool(spec).safeParse({ a: 'x'.repeat(64) }).success).toBe(true);
  });
});
