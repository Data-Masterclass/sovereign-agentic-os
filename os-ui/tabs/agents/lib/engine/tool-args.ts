/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Is this tool call fit to run? — argument validation and the model-reply guards
 * USER STORY: As the owner of an agent system I never want a tool — least of all a write — to run
 *             with arguments the model did not actually send: a tool call whose JSON was broken
 *             or cut off, or that leaves out a required field, goes back to the model as an
 *             error it can fix, a bounded number of times, and then the agent fails saying why.
 * ARCHITECTURE:
 *   - Pure. `checkToolArgs` validates a call against the input schema the tool registry already
 *     carries (the same JSON-schema object sent to the model): required fields, types, enums,
 *     nested objects and array items. Unknown extra fields are left to the tool.
 *   - LOSSLESS COERCION ONLY. A model that writes `"5"` for a number, `"true"` for a boolean or a
 *     JSON string for an array has said what it means; that value is converted. Nothing is ever
 *     DEFAULTED — a missing field is an error, not an empty string.
 *   - The bounds live here, in one place: {@link MAX_ARG_REPAIR_ATTEMPTS},
 *     {@link MAX_TRUNCATED_CALL_RETRIES}, {@link MAX_EMPTY_REPLY_NUDGES}.
 *   - Every refusal is the engine's usual typed envelope `{"error":{"code","reason",…}}`.
 */
import type { ToolCall, ToolSpec } from '@core/runtime/agentic';

/** How many times in a row the model may answer an invalid-arguments error with another invalid call. */
export const MAX_ARG_REPAIR_ATTEMPTS = 1;
/** How many times a tool call cut off at the output limit is asked for again, shorter. */
export const MAX_TRUNCATED_CALL_RETRIES = 1;
/** How many times an empty reply (no text, no tool call) is nudged before the agent fails. */
export const MAX_EMPTY_REPLY_NUDGES = 1;

/** The step name a model-reply problem is recorded under (no tool ran; the reply itself was the problem). */
export const MODEL_REPLY_STEP = '(model reply)';

type Schema = Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typesOf(schema: Schema): string[] {
  const t = schema.type;
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

const matches = (v: unknown, want: string): boolean => {
  const got = typeOf(v);
  return got === want || (want === 'number' && got === 'integer');
};

/** Convert a value the model wrote in the wrong JSON type when the conversion loses nothing. */
function coerce(v: unknown, wants: string[]): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if ((wants.includes('number') || wants.includes('integer')) && s !== '' && Number.isFinite(Number(s))) {
    const n = Number(s);
    if (wants.includes('number') || Number.isInteger(n)) return n;
  }
  if (wants.includes('boolean') && (s === 'true' || s === 'false')) return s === 'true';
  if ((wants.includes('array') && s.startsWith('[')) || (wants.includes('object') && s.startsWith('{'))) {
    try {
      const parsed: unknown = JSON.parse(s);
      if (wants.some((w) => matches(parsed, w))) return parsed;
    } catch {
      /* not JSON — leave it, and let the type check name the problem */
    }
  }
  return v;
}

const MAX_DEPTH = 6;

/** Validate `value` against `schema`; returns the (possibly coerced) value and appends problems. */
function check(value: unknown, schema: unknown, path: string, problems: string[], depth: number): unknown {
  if (!isRecord(schema) || depth > MAX_DEPTH) return value;
  const wants = typesOf(schema);
  let v = value;
  if (wants.length > 0 && !wants.some((w) => matches(v, w))) {
    v = coerce(v, wants);
    if (!wants.some((w) => matches(v, w))) {
      problems.push(`'${path}' must be ${wants.join(' or ')} (got ${typeOf(value)})`);
      return value;
    }
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && !schema.enum.some((e) => e === v)) {
    problems.push(`'${path}' must be one of: ${schema.enum.map((e) => String(e)).join(', ')}`);
    return v;
  }
  if (isRecord(v) && isRecord(schema.properties)) {
    const out: Record<string, unknown> = { ...v };
    for (const req of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof req === 'string' && (out[req] === undefined || out[req] === null)) problems.push(`missing required '${path ? `${path}.` : ''}${req}'`);
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (out[key] === undefined || out[key] === null) continue;
      out[key] = check(out[key], sub, path ? `${path}.${key}` : key, problems, depth + 1);
    }
    return out;
  }
  if (Array.isArray(v) && isRecord(schema.items)) {
    return v.map((item, i) => check(item, schema.items, `${path}[${i}]`, problems, depth + 1));
  }
  return v;
}

/** A compact, model-readable picture of what a tool expects: required names and each field's type. */
export function expectedShape(spec: ToolSpec): { required: string[]; properties: Record<string, string> } {
  const props = isRecord(spec.inputSchema?.properties) ? spec.inputSchema.properties : {};
  const properties: Record<string, string> = {};
  for (const [key, sub] of Object.entries(props).slice(0, 16)) {
    if (!isRecord(sub)) { properties[key] = 'any'; continue; }
    if (Array.isArray(sub.enum) && sub.enum.length > 0) properties[key] = sub.enum.map((e) => String(e)).join(' | ');
    else properties[key] = typesOf(sub).join(' | ') || 'any';
  }
  return { required: Array.isArray(spec.inputSchema?.required) ? spec.inputSchema.required.slice(0, 16) : [], properties };
}

export type ArgsVerdict =
  | { ok: true; /** The arguments to run with — the model's own, with lossless coercions applied. */ args: Record<string, unknown> }
  | { ok: false; /** One line naming the problem(s). */ problem: string; /** The typed tool result for the model. */ text: string };

const RAW_MAX = 200;

function invalid(tool: string, problem: string, spec: ToolSpec, received?: string): ArgsVerdict {
  const error: Record<string, unknown> = {
    code: 'invalid_argument',
    reason: `${tool} was NOT run: ${problem}. Send the call again with arguments that match "expected" — nothing is filled in for you.`,
    expected: expectedShape(spec),
  };
  if (received !== undefined) error.received = received.length > RAW_MAX ? `${received.slice(0, RAW_MAX)}…` : received;
  return { ok: false, problem, text: JSON.stringify({ error }) };
}

/**
 * Is this call fit to run? Not when its argument text was not a JSON object (`call.argsError`,
 * set by the model client), and not when the arguments fail the tool's own input schema.
 */
export function checkToolArgs(call: ToolCall, spec: ToolSpec): ArgsVerdict {
  if (call.argsError) {
    return invalid(call.name, `its arguments were not valid JSON (${call.argsError})`, spec, call.rawArgs);
  }
  const problems: string[] = [];
  const args = check(call.args ?? {}, spec.inputSchema, '', problems, 0);
  if (problems.length > 0) {
    const shown = problems.slice(0, 4).join('; ') + (problems.length > 4 ? `; and ${problems.length - 4} more` : '');
    return invalid(call.name, shown, spec);
  }
  return { ok: true, args: isRecord(args) ? args : {} };
}

/**
 * The check WITHOUT the schema: only a call whose argument text was not a JSON object is refused.
 * Not used in production — see `GraphDeps.checkArgs`.
 */
export function checkToolArgsJsonOnly(call: ToolCall, spec: ToolSpec): ArgsVerdict {
  if (call.argsError) return checkToolArgs(call, spec);
  return { ok: true, args: call.args ?? {} };
}

/** The typed result recorded for a tool call that was cut off at the model's output limit. */
export function truncatedCallResult(tool: string): string {
  return JSON.stringify({ error: { code: 'truncated_call', reason: `${tool} was NOT run: the model's reply was cut off at its output limit while it was writing this call, so its arguments may be incomplete.` } });
}

/** What the model is told after a cut-off tool call. */
export const TRUNCATED_CALL_PROMPT =
  'Your last reply was cut off at the output limit while you were writing a tool call, so NOTHING was executed. ' +
  'Send the call again, shorter: one tool call, with the smallest arguments that do the job (split large content across several calls).';

/** The typed result recorded when the model returned nothing at all. */
export function emptyReplyResult(): string {
  return JSON.stringify({ error: { code: 'empty_reply', reason: 'The model returned an empty reply (no text, no tool call); it was asked once more.' } });
}

/** What the model is told after an empty reply. */
export const EMPTY_REPLY_PROMPT =
  'Your last reply was empty. Either call one of your tools to continue the work, or write your final answer now.';

/** Appended to a final answer that was cut off at the output limit. */
export const TRUNCATED_ANSWER_NOTE = "\n\n_(This answer was cut off at the model's output limit — it may be incomplete.)_";
