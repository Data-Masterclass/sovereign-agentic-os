/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * FRIENDLY QUERY-ERROR TRANSLATOR — turns a raw Trino/query error into one plain,
 * actionable sentence, while keeping the raw text reachable for developers.
 *
 * The data tab runs real governed SQL (previews, derived-field builds, quality
 * checks). When an expression is wrong, Trino answers with a stack-trace-shaped
 * `TrinoUserError(type=…, name=…, message="line 1:362: …", query_id=…)`. That is
 * accurate but unreadable — a first-time user reads "TYPE_MISMATCH" and stops. This
 * pattern-matches the common shapes and rewrites the FRIENDLY line; the RAW string is
 * always returned unchanged so a "Show details" disclosure can surface the query_id.
 *
 * Pure + transport-free (no server-only / Next / network) so any surface — client
 * component or route — can import it. Non-Trino input passes through untouched.
 */

export type FriendlyError = { friendly: string; raw: string };

/** Pull the inner `message="…"` out of a `TrinoUserError(…)` wrapper, stripping the
 *  `type=`, `name=` and `query_id=` noise. Returns the whole raw when no wrapper. */
function innerMessage(raw: string): string {
  const m = raw.match(/message="((?:[^"\\]|\\.)*)"/);
  if (m) return m[1].replace(/\\"/g, '"').trim();
  // No quoted message field — strip a bare `TrinoUserError(...)` wrapper if present.
  const wrap = raw.match(/^\s*\w*Error\((.*)\)\s*$/s);
  return (wrap ? wrap[1] : raw).trim();
}

/** The Trino `name=` classifier, when the wrapper carries one. */
function errorName(raw: string): string {
  return raw.match(/name=([A-Z_]+)/)?.[1] ?? '';
}

/**
 * Translate a raw query error into `{ friendly, raw }`. `raw` is ALWAYS the input
 * unchanged (developers need the query_id); `friendly` is the plain sentence to show.
 */
export function friendlyTrinoError(raw: string): FriendlyError {
  const input = typeof raw === 'string' ? raw : String(raw ?? '');
  const inner = innerMessage(input);
  const name = errorName(input);
  const isTrino = /TrinoUserError|\bname=[A-Z_]+/.test(input);

  // TYPE_MISMATCH — "Cannot apply operator: varchar * integer" (the live report).
  const opMix = inner.match(/Cannot apply operator:\s*(\w+)\s*([-+*/])\s*(\w+)/i);
  if (opMix && (name === 'TYPE_MISMATCH' || !name)) {
    const [, a, , b] = opMix;
    const textSide = /char|varchar|string/i.test(a) ? a : b;
    return {
      friendly:
        `This calculation mixes text and numbers: one of the columns is text (${textSide}). ` +
        `Cast it to a number in the expression (e.g. CAST(col AS double)) or fix its type in Transformation.`,
      raw: input,
    };
  }
  if (name === 'TYPE_MISMATCH') {
    return {
      friendly:
        `A type doesn't match in this expression — a text and a numeric column are being combined. ` +
        `Cast the text column to a number (e.g. CAST(col AS double)) or fix its type in Transformation.`,
      raw: input,
    };
  }

  // INVALID_CAST_ARGUMENT — "Cannot cast 'CUS-2002' to INT" (a cast the values contradict).
  const badCast = inner.match(/Cannot cast ['"]?(.+?)['"]? to (\w+)/i);
  if (badCast && (name === 'INVALID_CAST_ARGUMENT' || /Cannot cast/i.test(inner))) {
    const [, value, target] = badCast;
    return {
      friendly:
        `A value like '${value}' can't become a ${target.toLowerCase()} — the column holds text that isn't a plain number. ` +
        `Keep it as text, or clean the values first in Transformation.`,
      raw: input,
    };
  }

  // COLUMN_NOT_FOUND — "Column 'x' cannot be resolved".
  const col =
    inner.match(/Column ['"]?([\w.]+)['"]? cannot be resolved/i)?.[1] ??
    (name === 'COLUMN_NOT_FOUND' ? inner.match(/['"]([\w.]+)['"]/)?.[1] : undefined);
  if (col && (name === 'COLUMN_NOT_FOUND' || /cannot be resolved/i.test(inner))) {
    return {
      friendly: `Column '${col}' doesn't exist on this dataset — check the spelling against the schema.`,
      raw: input,
    };
  }

  // SYNTAX_ERROR — mismatched input / parse failure.
  if (name === 'SYNTAX_ERROR' || /mismatched input|SYNTAX_ERROR/i.test(inner)) {
    return {
      friendly: `The expression isn't valid SQL — check the syntax near the reported position.`,
      raw: input,
    };
  }

  // Fallback: a Trino wrapper we don't have a bespoke line for — show the inner
  // message without the wrapper/query_id noise. Non-Trino input passes through.
  return { friendly: isTrino ? inner : input, raw: input };
}
