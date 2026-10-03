/**
 * Companion's hello and call replies, checked at runtime. The shim registers tools and reports
 * outcomes from these frames, so a missing field must fail here with a clear code instead of as a
 * crash in the tool loop or the word "undefined" in front of the agent.
 */
import { z } from 'zod';
import { BridgeError } from './errors.js';
import type { CallResult, ToolSpec } from './client.js';

// What MCP clients accept as a tool name; companion_status is the shim's own and never Companion's.
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED = new Set(['companion_status']);

// The schema builder keys a plain object by property name; these would set its prototype instead.
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const propertySchema = z.object({
  name: z
    .string()
    .regex(TOOL_NAME)
    .refine((name) => !PROTOTYPE_KEYS.has(name)),
  type: z.string(),
  description: z.string(),
  // Judged by the schema builder, which ignores a malformed constraint instead of the whole tool.
  enum: z.unknown().optional(),
  minLength: z.unknown().optional(),
  maxBytes: z.unknown().optional(),
});

const toolSchema = z.object({
  name: z
    .string()
    .regex(TOOL_NAME)
    .refine((name) => !RESERVED.has(name)),
  description: z.string(),
  properties: z.array(propertySchema),
  required: z.array(z.string()),
});

const helloSchema = z.object({ session: z.string(), tools: z.unknown() });

/**
 * `tools` is null when the list itself is unusable: the session still opens, so a call already on
 * its way gets its result, and the caller keeps the tools it registered before.
 */
export function parseHello(raw: unknown): { session: string; tools: ToolSpec[] | null } {
  const hello = helloSchema.safeParse(raw);
  if (!hello.success) throw new BridgeError('bad_frame', 'Companion sent a malformed hello');
  if (!Array.isArray(hello.data.tools)) {
    process.stderr.write('[bridge] hello: no usable tool list; keeping the previous one\n');
    return { session: hello.data.session, tools: null };
  }
  const tools: ToolSpec[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  // One bad tool costs only itself: the rest of the hello is still Companion's word.
  for (const entry of hello.data.tools) {
    const parsed = toolSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.name)) {
      dropped += 1;
      continue;
    }
    seen.add(parsed.data.name);
    tools.push(parsed.data);
  }
  // A count, never the entries: they are Companion's text and stderr is not the place for it.
  if (dropped > 0) process.stderr.write(`[bridge] hello: dropped ${dropped} malformed tool(s)\n`);
  // Every entry failing is a protocol mismatch, not Companion offering nothing: keep what is there.
  if (tools.length === 0 && dropped > 0) return { session: hello.data.session, tools: null };
  return { session: hello.data.session, tools };
}

const callSchema = z.object({
  ok: z.boolean(),
  output: z.unknown(),
  target: z.unknown(),
});

export function parseCallResult(raw: unknown): CallResult {
  const reply = callSchema.safeParse(raw);
  if (!reply.success) {
    // Without ok there is no telling whether the action ran.
    throw new BridgeError(
      'bad_frame',
      'Companion sent a malformed reply. Call look to check whether the action happened before retrying.',
    );
  }
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  return { ok: reply.data.ok, output: text(reply.data.output), target: text(reply.data.target) };
}
