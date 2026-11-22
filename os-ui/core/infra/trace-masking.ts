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

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g;
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
const PHONE = /(?<![\w+])(?:\+|00)\d{1,3}[\d ()./-]{6,16}\d|(?<![\w(])\(\d{2,5}\)[ ]?\d[\d -]{4,}\d|(?<![\w.])0\d{2,4}[ /-]\d{3,}(?:[ -]\d+)*/g;

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
  const groups = candidate.split(' ');
  for (let k = groups.length; k >= 1; k--) {
    if (ibanValid(groups.slice(0, k).join(''))) return ['[iban]', ...groups.slice(k)].join(' ');
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
 * The Langfuse SDK's `mask` hook for PII: it receives the attribute as JSON text. The strings in
 * that JSON are scrubbed and the JSON is written back; text that is not JSON is scrubbed as text;
 * anything that is not a string is returned as it is.
 */
export function maskExportedAttribute(data: unknown): unknown {
  if (typeof data !== 'string') return data;
  try {
    return JSON.stringify(scrubDeep(JSON.parse(data)));
  } catch {
    return scrubPii(data);
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
