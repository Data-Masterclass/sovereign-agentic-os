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

/** Whether a CARD match is a card: 13–19 digits, Luhn-valid, and separated unless 15+ digits long. */
function isCard(m: string): boolean {
  const digits = m.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  // Unseparated runs of 13–14 digits are far more often a timestamp or an id than a card.
  if (!/[ -]/.test(m) && digits.length < 15) return false;
  return luhnValid(digits);
}

// The IBAN length of every country in the SWIFT IBAN registry. Used only to decide whether a UUID or
// an OS id CARRIES an IBAN: there the mod-97 check alone passes for ~1 in 97 random hex runs, while a
// real IBAN always has its country's exact length (BE68 5390 0754 7034 is 16, DE89 … 3000 is 22).
const IBAN_LENGTH: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28, CH: 21, CR: 22,
  CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27, GB: 22,
  GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30,
  KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27,
  MT: 31, MU: 30, NI: 28, NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24,
  SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22,
  VG: 24, XK: 20, YE: 30,
};

/**
 * Whether `value` holds a Luhn-valid card or a valid IBAN (registered country, its exact length,
 * mod 97) by the same patterns the scrub uses. Such a value is never set aside or exempted as an
 * id, whatever its shape: `41111111-1111-1111-0000-…` is a test card, `BE685390-0754-7034-0000-…`
 * a Belgian IBAN, both in UUID shape.
 */
function carriesCardOrIban(value: string): boolean {
  for (const m of value.match(CARD) ?? []) if (isCard(m)) return true;
  for (const m of value.match(IBAN) ?? []) {
    const groups = m.split(/[ -]/);
    for (let k = groups.length; k >= 1; k--) {
      const compact = groups.slice(0, k).join('').toUpperCase();
      if (IBAN_LENGTH[compact.slice(0, 2)] === compact.length && ibanValid(compact)) return true;
    }
  }
  return false;
}

// A canonical UUID (8-4-4-4-12 hex) standing on its own. Its hex groups are not personal data, but
// a run of them can look like one: `a593d120-0321-4584-9a23-…` held a phone shape (`0321-4584-9`) and
// `dc41e1c2-218f-423a-…` an IBAN with a valid checksum, in ~0.7% of random UUIDs. Only the exact UUID
// shape is set aside, and only when it carries no card or IBAN (`carriesCardOrIban`), so a card or
// an IBAN written in UUID shape is still masked.
const UUID = /(?<![\w-])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?![\w-])/g;

/** IBAN, card and phone numbers in a piece of text that holds no UUID. */
function scrubNumbers(text: string): string {
  return text
    .replace(IBAN, (m) => replaceIban(m))
    .replace(CARD, (m) => (isCard(m) ? '[card]' : m))
    .replace(PHONE, (m) => {
      const n = m.replace(/\D/g, '').length;
      return n >= 8 && n <= 15 ? '[phone]' : m;
    });
}

/** Personal data in a piece of text replaced by `[email]`, `[iban]`, `[card]` and `[phone]`. */
export function scrubPii(text: string): string {
  // E-mail first, on the whole text (a UUID can be the local part of an address); then the number
  // patterns only on the text BETWEEN UUIDs, so no number pattern can start or end inside one. A
  // UUID that carries a card or an IBAN is not set aside: it is scrubbed with the text around it.
  const mailed = text.replace(EMAIL, '[email]');
  let out = '';
  let from = 0;
  for (const m of mailed.matchAll(UUID)) {
    if (carriesCardOrIban(m[0])) continue;
    out += scrubNumbers(mailed.slice(from, m.index)) + m[0];
    from = m.index! + m[0].length;
  }
  return out + scrubNumbers(mailed.slice(from));
}

/**
 * The keys whose values the OS itself mints as identifiers: the gateway call id it sends as
 * `x-litellm-call-id` and records as `litellm_call_id` (`core/infra/langfuse.ts`) / `gatewayCallId`
 * (`core/runtime`, `tabs/agents/lib/module/observe.ts`), the tool-call id (`callId`), the approval
 * card (`approvalId`), the run and the agent system (`runId`, `systemId` on the trace). Monitoring
 * joins on them (the span's `litellm_call_id` must equal the gateway generation's `litellm.call_id`),
 * so one changed character breaks the join. Generic keys (`id`, `call_id`, `name`) are NOT here: they
 * also occur in tool arguments and results, which are content.
 */
const OS_ID_KEYS = new Set(['litellm_call_id', 'gatewayCallId', 'callId', 'approvalId', 'runId', 'systemId']);
// An id-shaped value: a UUID or a 32-hex id, optionally behind one of the prefixes the OS mints
// (`run_` core/kernel/run-id.ts, `sys-` app/api/platform-admin/components, `apr_` core/policy/approvals.ts).
// The shape holds no e-mail address and, being hex groups, no phone number the OS writes; it CAN spell a
// card or an IBAN (`41111111-1111-1111-0000-…`), so `isOsId` also requires `!carriesCardOrIban`. A value
// that fails either test is scrubbed like everything else.
const OS_ID_VALUE = /^(?:run_|sys-|apr_)?(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}|[0-9a-f]{32})$/;

/** Whether `value` under `key` is an OS-minted identifier, exported exactly as it is. */
function isOsId(key: string, value: unknown): value is string {
  return typeof value === 'string' && OS_ID_KEYS.has(key) && OS_ID_VALUE.test(value) && !carriesCardOrIban(value);
}

function scrubDeep(value: unknown): unknown {
  if (typeof value === 'string') return scrubPii(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = isOsId(k, v) ? v : scrubDeep(v);
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
  ...OS_ID_KEYS,
  'tool', 'name', 'id', 'call_id', 'decision', 'redaction',
  'kind', 'type', 'asType', 'role', 'model', 'node', 'agent', 'engine', 'masking', 'status', 'level', 'environment',
  'domain', 'path', 'finishReason', 'finish_reason', 'stopReason', 'tag', 'tags',
  // How a model call ended (enums, never content): kept readable so "why was the reply empty" can be answered with masking on.
  'reasoning_effort', 'retry_reasoning_effort',
  // Who a connection call acted for and whose credential it used (ids and enums, never content):
  // kept readable at `content` so the audit question "who did this" survives; PII scrub still applies.
  'actingUser', 'credentialMode', 'credentialSubject', 'requestedBy', 'approvedBy', 'trigger', 'schedule',
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
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = isOsId(k, v) ? v : contentOnly(v, STRUCTURAL_KEYS.has(k));
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
      // An OS-minted id is a join key (litellm_call_id ↔ the gateway's litellm.call_id): never changed.
      if (prefix && isOsId(key.slice(prefix.length), value)) continue;
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

// ---------------------------------------------------------------- secret-named arguments --

/** Argument keys whose value is a secret. Matched on the key with `_`, `-` and spaces removed, any case. */
const SECRET_KEY = /pass(word|wd|phrase)?$|secret|token|apikey|accesskey|privatekey|authorization|bearer|credential|cookie|sessionid|signature/i;

export const REDACTED = '[redacted]';

/**
 * `args` with every value whose KEY names a secret (password, token, api key, …) replaced by
 * `[redacted]`, at any depth. Never mutates. Applied to tool arguments before they reach a trace,
 * whatever the masking switch says: a secret is never exported, masking on or off.
 */
export function redactSecretArgs<T>(args: T): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 8 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k.replace(/[_\-\s]/g, '')) ? REDACTED : walk(x, depth + 1);
    }
    return out;
  };
  return walk(args, 0) as T;
}
