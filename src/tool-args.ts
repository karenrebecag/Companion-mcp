/**
 * The schema each Companion tool's arguments must meet before the call
 * leaves the shim. Checking here means a typo or an oversized value comes
 * back to the agent as a schema error it can fix, not as a lost argument, a
 * sheet on the Mac, or a frame Companion refuses.
 */
import { z } from 'zod';
import type { ToolSpec } from './bridge/client.js';
import { stripInvisible } from './core/screen-text.js';

// Incredible's text limit. Per string, not per call: Companion's 64 KB line limit still guards the frame.
export const MAX_STRING_BYTES = 16_000;

type Property = ToolSpec['properties'][number];

// Enum values reach the agent in the schema and in every validation error.
const MAX_ENUM_VALUES = 50;
const MAX_ENUM_VALUE_LENGTH = 64;

function plainChoice(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ENUM_VALUE_LENGTH &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1F\x7F\u2028\u2029]/.test(value) &&
    stripInvisible(value) === value
  );
}

// The hello is Companion's word, not proof: a constraint of the wrong shape is ignored, not trusted.
function declaredEnum(prop: Property): [string, ...string[]] | undefined {
  const values = prop.enum;
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_ENUM_VALUES)
    return undefined;
  if (!values.every(plainChoice)) return undefined;
  return values as [string, ...string[]];
}

function declaredCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function stringSchema(prop: Property): z.ZodType {
  const choices = declaredEnum(prop);
  if (choices) {
    return z.enum(choices, {
      errorMap: () => ({ message: `must be one of: ${choices.join(', ')}` }),
    });
  }
  // A declared limit can only tighten the shim's ceiling, never lift it.
  const maxBytes = Math.min(declaredCount(prop.maxBytes) ?? MAX_STRING_BYTES, MAX_STRING_BYTES);
  const minLength = declaredCount(prop.minLength);
  let schema = z.string();
  if (minLength !== undefined) {
    schema = schema.min(minLength, { message: `must have at least ${minLength} characters` });
  }
  return schema
    .refine((s) => !s.includes('\u0000'), { message: 'must contain no NUL character' })
    .refine((s) => Buffer.byteLength(s, 'utf8') <= maxBytes, {
      message: `must be at most ${maxBytes} UTF-8 bytes`,
    });
}

function fieldSchema(prop: Property): z.ZodType {
  switch (prop.type) {
    case 'string':
      return stringSchema(prop);
    case 'integer':
      return z.number().int();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    default:
      return z.unknown();
  }
}

export function buildSchemaForTool(spec: ToolSpec): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};
  for (const prop of spec.properties) {
    const field = fieldSchema(prop);
    shape[prop.name] = spec.required.includes(prop.name) ? field : field.optional();
  }
  // Strict: a misspelled key would otherwise vanish and the call run without it.
  return z.object(shape).strict();
}
