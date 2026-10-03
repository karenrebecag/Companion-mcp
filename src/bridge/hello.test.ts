import { describe, it, expect } from 'vitest';
import { parseHello, parseCallResult } from './hello.js';
import { BridgeError } from './errors.js';

const tool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: name,
  properties: [{ name: 'id', type: 'integer', description: 'id' }],
  required: ['id'],
  ...extra,
});

const hello = (tools: unknown) => ({ session: 's', language: 'en', accessibility: true, tools });

describe('parseHello', () => {
  it('keeps every well-formed tool', () => {
    const out = parseHello(hello([tool('look'), tool('click')]));
    expect(out.session).toBe('s');
    expect(out.tools?.map((t) => t.name)).toEqual(['look', 'click']);
  });

  it('drops a malformed tool without losing the rest', () => {
    const out = parseHello(
      hello([
        tool('look'),
        { name: 'no_properties', description: 'x', required: [] },
        tool('bad name with spaces'),
        tool('companion_status'),
        tool('x'.repeat(65)),
        tool('click', { properties: [{ name: 'id', type: 7, description: 'id' }] }),
        tool('look'),
        42,
        tool('scroll'),
      ]),
    );
    expect(out.tools?.map((t) => t.name)).toEqual(['look', 'scroll']);
  });

  it('an unusable tool list keeps the session and says so with null', () => {
    expect(parseHello({ session: 's' }).tools).toBeNull();
    expect(parseHello({ session: 's', tools: {} }).tools).toBeNull();
    // Every entry failing reads as a protocol mismatch, not as Companion offering nothing.
    expect(parseHello(hello([42, tool('bad name')])).tools).toBeNull();
    expect(parseHello(hello([])).tools).toEqual([]);
  });

  it('a property named after an object prototype key drops its tool', () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      const spec = tool('click', {
        properties: [{ name, type: 'string', description: 'x' }],
        required: [],
      });
      expect(parseHello(hello([spec, tool('look')])).tools?.map((t) => t.name)).toEqual(['look']);
    }
  });

  it('a hello without a session is a malformed frame, not a crash later', () => {
    for (const raw of [null, 'x', { tools: [] }, { session: 7, tools: [] }]) {
      expect(() => parseHello(raw)).toThrow(BridgeError);
      try {
        parseHello(raw);
      } catch (err) {
        expect((err as BridgeError).code).toBe('bad_frame');
      }
    }
  });

  it('passes declared constraints through for the schema builder to judge', () => {
    const spec = tool('scroll', {
      properties: [
        { name: 'direction', type: 'string', description: 'd', enum: ['up'], maxBytes: 9 },
      ],
      required: ['direction'],
    });
    const prop = parseHello(hello([spec])).tools?.[0].properties[0];
    expect(prop?.enum).toEqual(['up']);
    expect(prop?.maxBytes).toBe(9);
  });
});

describe('parseCallResult', () => {
  it('reads a well-formed reply', () => {
    expect(parseCallResult({ ok: true, output: 'done', target: 'Notes' })).toEqual({
      ok: true,
      output: 'done',
      target: 'Notes',
    });
  });

  it('a missing output or target reads as empty, never as "undefined"', () => {
    expect(parseCallResult({ ok: false })).toEqual({ ok: false, output: '', target: '' });
    expect(parseCallResult({ ok: true, output: 3, target: null })).toEqual({
      ok: true,
      output: '',
      target: '',
    });
  });

  it('a reply without ok cannot say whether it acted', () => {
    for (const raw of [null, 'done', {}, { ok: 'yes', output: 'x' }]) {
      try {
        parseCallResult(raw);
        expect.unreachable();
      } catch (err) {
        expect((err as BridgeError).code).toBe('bad_frame');
        expect((err as BridgeError).message).toMatch(/call look/i);
      }
    }
  });
});
