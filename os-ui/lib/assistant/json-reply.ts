/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Robustly recover a JSON object from a model reply that is SUPPOSED to be strict JSON
 * but, in practice, often is not — reasoning-tier models routinely wrap the object in a
 * sentence of preamble ("Here is the plan:"), a trailing note, or a ```json fence. A naive
 * `JSON.parse` fails on any of that, and the caller then falls back to showing the raw blob
 * with NO structured suggestions (in the Software Design stage that reads as "poorly
 * formatted markdown and no epics/stories created"). This module is the ONE tolerant parser
 * those structured stages share.
 */

/**
 * Scan for the FIRST balanced `{…}` object in `s`, respecting string literals + escapes so
 * a brace inside a quoted value never miscounts depth. Returns the substring (inclusive) or
 * null when there is no complete object.
 */
export function extractJsonObject(s: string): string | null {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Scan for the FIRST balanced `[…]` array in `s`, respecting string literals + escapes so a
 * bracket inside a quoted value never miscounts depth. The array sibling of
 * {@link extractJsonObject}, for structured stages whose payload is a top-level ARRAY (e.g.
 * the Dashboards charts stage). Returns the substring (inclusive) or null.
 */
export function extractJsonArray(s: string): string | null {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ']') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Parse a structured-stage reply defensively. Try the whole (fence-stripped) string first;
 * if that is not valid JSON, extract the first balanced object from within the prose and
 * parse THAT. Returns the parsed value, or null when nothing usable is present.
 */
export function parseJsonReply(content: string): unknown {
  const cleaned = content.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Reasoning models often wrap the object in preamble/thinking — recover it.
  }
  const extracted = extractJsonObject(cleaned);
  if (extracted) {
    try {
      return JSON.parse(extracted);
    } catch {
      // Extracted span still wasn't valid JSON — give up honestly.
    }
  }
  return null;
}

/**
 * Parse a structured-stage reply that is SUPPOSED to be a top-level JSON ARRAY, tolerating the
 * same preamble/fence wrapping {@link parseJsonReply} handles for objects. Returns the parsed
 * array, or null when nothing usable is present.
 */
export function parseJsonArrayReply(content: string): unknown[] | null {
  const cleaned = content.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const whole = JSON.parse(cleaned);
    if (Array.isArray(whole)) return whole;
  } catch {
    // Fall through to recover an array embedded in prose.
  }
  const extracted = extractJsonArray(cleaned);
  if (extracted) {
    try {
      const arr = JSON.parse(extracted);
      if (Array.isArray(arr)) return arr;
    } catch {
      // Extracted span still wasn't valid JSON — give up honestly.
    }
  }
  return null;
}
