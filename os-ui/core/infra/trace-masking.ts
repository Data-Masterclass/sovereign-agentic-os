/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Trace masking — the policy shape, the PII patterns and the content shape
 * USER STORY: As a platform admin who switched masking on I want an e-mail address, a phone
 *             number, an IBAN or a card number replaced in anything the OS sends to Langfuse, and
 *             I want ids, timestamps and counts left exactly as they were so Monitoring keeps working.
 * ARCHITECTURE:
 *   - Pure: no I/O, no config, no SDK. `core/infra/langfuse.ts` hands `maskExportedAttribute` to
 *     the Langfuse span processor's documented `mask` option
 *     (https://langfuse.com/docs/observability/features/masking): the SDK calls it with the
 *     JSON text of every observation's input, output and metadata. It is applied there, at export,
 *     so nothing the OS builds can skip it.
 *   - Two levels. `pii` replaces personal data and keeps everything else. `content` replaces ALL
 *     message, task, tool-argument and tool-result text by its size and keeps the metadata (model,
 *     tokens, latency, cost, tool names, decisions, status); the writer applies it where it builds
 *     each observation, because only there is it known which field is content.
 *   - Patterns are validated (IBAN mod 97, card Luhn, digit counts) so an order number, a
 *     timestamp or a UUID is not mistaken for personal data. Only JSON string leaves are
 *     scrubbed, so a number in the JSON can never be turned into text.
 */

export type MaskingLevel = 'pii' | 'content';
export type MaskingPolicy = { enabled: boolean; level: MaskingLevel };

/** Today's behaviour: masking off. The level is what "on" would do. */
export const DEFAULT_MASKING: MaskingPolicy = { enabled: false, level: 'pii' };

/**
 * What applies while the switch has not been READ (a pod that just restarted, a settings store that
 * cannot be reached): the strictest level. A privacy control that cannot tell whether it is on
 * behaves as if it were on, at its strongest.
 */
export const UNKNOWN_MASKING: MaskingPolicy = { enabled: true, level: 'content' };

/**
 * A stored or patched value as a policy: only a real boolean flips `enabled`, only a known level
 * sets `level`; anything else keeps `base` (nil-safe, like every platform flag).
 */
export function normalizeMasking(value: unknown, base: MaskingPolicy = DEFAULT_MASKING): MaskingPolicy {
  if (!value || typeof value !== 'object') return { ...base };
  const v = value as Record<string, unknown>;
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : base.enabled,
    level: v.level === 'pii' || v.level === 'content' ? v.level : base.level,
  };
}

// ---------------------------------------------------------------- patterns --

// Quoted local part ("john doe"@x), or a local part of letters/digits in any script and the RFC 5322
// atext symbols; the domain is a run of labels in any script (IDN, punycode `xn--`) ending in a TLD.
const EMAIL = /(?:"(?:[^"\\\r\n]|\\.){1,64}"|[\p{L}\p{N}._%+'!#$&*/=?^`{|}~-]+)@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}\p{N}-]{2,}/giu;
// Two letters (any case) + two check digits + groups of four, separated by nothing, a space or a hyphen.
const IBAN = /\b[A-Za-z]{2}\d{2}(?:[ -]?[A-Za-z0-9]{4}){2,7}(?:[ -]?[A-Za-z0-9]{1,4})?\b/g;
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
// Phone shapes. Everything not starting with +, 00 or a trunk 0 must have a telephone shape of its own,
// so a date, an amount, a version or an id is not taken for a number:
//   +/00 prefix with separators · (area) number · 0 + separators · 0 + 10-11 bare digits (01701234567)
//   · NANP 555-123-4567 / 555.123.4567 / 555 123 4567 / 5551234567 (the area code starts 2-9, so an epoch
//   second 17xxxxxxxx is not one) · country code without + as separated groups (49 170 1234567).
const PHONE = new RegExp([
  String.raw`(?<![\w+])(?:\+|00)\d{1,3}[\d ()./-]{6,16}\d`,
  String.raw`(?<![\w(])\(\d{2,5}\)[ ]?\d[\d -]{4,}\d`,
  String.raw`(?<![\w.])0\d{2,4}[ /-]\d{3,}(?:[ -]\d+)*`,
  String.raw`(?<![\w.,-])0\d{9,11}(?![\w.,-])`,
  String.raw`(?<![\w.,-])[2-9]\d{2}[-. ]\d{3}[-. ]\d{4}(?![\w-]|[.,]\d)`,
  String.raw`(?<![\w.,-])[2-9]\d{9}(?![\w.,-])`,
  String.raw`(?<![\w.,+-])[1-9]\d{1,2} \d{2,4} \d{5,8}(?![\w-]|[.,]\d)`,
].join('|'), 'g');

function ibanValid(compact: string): boolean {
  if (compact.length < 15 || compact.length > 34) return false;
  const moved = compact.slice(4) + compact.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const code = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of code) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Replace the IBAN at the start of `candidate` (a run of space-separated groups); keep any trailing words. */
function replaceIban(candidate: string): string {
  const groups = candidate.split(/[ -]/);
  const seps = candidate.match(/[ -]/g) ?? [];
  for (let k = groups.length; k >= 1; k--) {
    if (ibanValid(groups.slice(0, k).join('').toUpperCase())) {
      const rest = groups.slice(k).map((g, i) => `${seps[k - 1 + i] ?? ' '}${g}`).join('');
      return `[iban]${rest}`;
    }
  }
  return candidate;
}

/** Personal data in a piece of text replaced by `[email]`, `[iban]`, `[card]` and `[phone]`. */
export function scrubPii(text: string): string {
  return text
    .replace(EMAIL, '[email]')
    .replace(IBAN, (m) => replaceIban(m))
    .replace(CARD, (m) => {
      const digits = m.replace(/[ -]/g, '');
      const separated = /[ -]/.test(m);
      if (digits.length < 13 || digits.length > 19) return m;
      // Unseparated runs of 13–14 digits are far more often a timestamp or an id than a card.
      if (!separated && digits.length < 15) return m;
      return luhnValid(digits) ? '[card]' : m;
    })
    .replace(PHONE, (m) => {
      const n = m.replace(/\D/g, '').length;
      return n >= 8 && n <= 15 ? '[phone]' : m;
    });
}

function scrubDeep(value: unknown): unknown {
  if (typeof value === 'string') return scrubPii(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubDeep(v);
    return out;
  }
  return value;
}

/**
 * The keys whose string values are STRUCTURE, never content: names the OS itself chose (a tool, a
 * node, a decision, a model, an id). At the content level every other string is reduced to its size,
 * so a field nobody thought of at build time is covered by default: unknown means masked.
 */
const STRUCTURAL_KEYS = new Set([
  'tool', 'name', 'id', 'callId', 'call_id', 'litellm_call_id', 'gatewayCallId', 'approvalId', 'decision', 'redaction',
  'kind', 'type', 'asType', 'role', 'model', 'node', 'agent', 'engine', 'masking', 'status', 'level', 'environment',
  'systemId', 'domain', 'runId', 'path', 'finishReason', 'finish_reason', 'stopReason', 'tag', 'tags',
]);

const isShape = (v: unknown): boolean => !!v && typeof v === 'object' && (v as { redacted?: unknown }).redacted === true && typeof (v as { chars?: unknown }).chars === 'number';

/**
 * A value with every text leaf reduced to its size (`{ redacted, chars }`), except the values of
 * structural keys (and the items of an array under one); numbers, booleans and null stay. Used by
 * the writer for metadata and, at export, for anything the writer did not reduce.
 */
export function contentOnly(value: unknown, structural = false): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return structural ? value : contentShape(value);
  if (Array.isArray(value)) return value.map((v) => contentOnly(v, structural));
  if (value && typeof value === 'object') {
    if (isShape(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = contentOnly(v, STRUCTURAL_KEYS.has(k));
    return out;
  }
  return value;
}

function reduce(value: unknown, policy?: MaskingPolicy): unknown {
  return policy?.enabled && policy.level === 'content' ? contentOnly(value) : value;
}

/**
 * The Langfuse SDK's `mask` hook: it receives the attribute as JSON text. At the `content` level
 * text the writer did not reduce is reduced here (the writer cannot be the only line of defence);
 * then the strings that remain are scrubbed of personal data and the JSON is written back. Text that
 * is not JSON is reduced or scrubbed as text; anything that is not a string is returned as it is.
 * Without a policy the PII scrub applies, as before.
 */
export function maskExportedAttribute(data: unknown, policy?: MaskingPolicy): unknown {
  if (typeof data !== 'string') return data;
  try {
    return JSON.stringify(scrubDeep(reduce(JSON.parse(data), policy)));
  } catch {
    return policy?.enabled && policy.level === 'content' ? JSON.stringify(contentShape(data)) : scrubPii(data);
  }
}

/** A value reduced to its size: the shape of the content without the content. */
export function contentShape(value: unknown): { redacted: true; chars: number } | undefined {
  if (value === undefined) return undefined;
  return { redacted: true, chars: (typeof value === 'string' ? value : JSON.stringify(value ?? null)).length };
}

/** Free text (an error message, a score comment) as the policy allows it to be exported. */
export function maskText(text: string | undefined, policy: MaskingPolicy): string | undefined {
  if (text === undefined || !policy.enabled) return text;
  return policy.level === 'content' ? undefined : scrubPii(text);
}

// ------------------------------------------------- attributes the mask hook skips --

const FLAT_METADATA = ['langfuse.observation.metadata.', 'langfuse.trace.metadata.'];
// A number, boolean or null the SDK serialised to text (metadata values are stored as strings).
const SCALAR_TEXT = /^(?:-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|null)$/i;
const STATUS_MESSAGE = 'langfuse.observation.status_message';

/**
 * The span attributes the SDK's `mask` hook is never given: each key of an object-valued metadata
 * is its own attribute (`langfuse.observation.metadata.<key>`), and the status message is one too.
 * Masked in place, at export, by the policy: at `content` free text becomes its size (structural
 * keys keep their words) and the status message is dropped; at `pii` personal data is replaced.
 * Anything that goes wrong removes the attribute: never exported unmasked.
 */
export function maskFlatAttributes(attributes: Record<string, unknown>, policy: MaskingPolicy): void {
  if (!policy.enabled) return;
  for (const key of Object.keys(attributes)) {
    const prefix = FLAT_METADATA.find((p) => key.startsWith(p));
    if (!prefix && key !== STATUS_MESSAGE) continue;
    try {
      const value = attributes[key];
      if (typeof value !== 'string') continue;
      if (key === STATUS_MESSAGE) {
        if (policy.level === 'content') delete attributes[key];
        else attributes[key] = scrubPii(value);
      } else if (policy.level === 'content' && !STRUCTURAL_KEYS.has(key.slice(prefix!.length)) && !SCALAR_TEXT.test(value)) {
        attributes[key] = JSON.stringify(contentShape(value));
      } else {
        // Structural words and scalars keep their value; personal data in them is still replaced.
        attributes[key] = policy.level === 'content' ? scrubPii(value) : maskExportedAttribute(value, policy);
      }
    } catch {
      delete attributes[key];
    }
  }
}
