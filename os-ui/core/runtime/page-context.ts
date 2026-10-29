/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * PAGE CONTEXT (server side) — turn the client's "where am I right now?" snapshot
 * into a short, honest preamble the assistant is grounded on.
 *
 * The client store (components/core/PageContext.tsx) publishes what the user is
 * looking at — the current tab, sub-stage/step and the OPEN artifact (id + name +
 * type). The Ask-the-OS surface sends that alongside the pathname; here we fold it
 * into the system prompt so the model treats the open artifact as the DEFAULT
 * subject instead of asking for an id it can already see.
 *
 * Pure + defensive: with no page-context (the common case, and every surface that
 * hasn't published one) this returns '' and the assistant behaves EXACTLY as
 * before. It only ever ENRICHES.
 */

/** The wire shape the client sends. Mirrors components/core/PageContext.tsx. All
 *  fields beyond `tab` are optional; anything can be missing or malformed. */
export type PageContextInput = {
  tab?: unknown;
  stage?: unknown;
  artifactType?: unknown;
  artifactId?: unknown;
  artifactName?: unknown;
  extra?: unknown;
};

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** A sanitized, trusted snapshot (only present when the client sent usable data). */
export type PageContext = {
  tab?: string;
  stage?: string;
  artifactType?: string;
  artifactId?: string;
  artifactName?: string;
  extra?: Record<string, string>;
};

/**
 * Sanitize an untrusted client payload into a PageContext, or null if there's
 * nothing usable. Drops non-string fields and empty values; caps sizes so a hostile
 * client can't bloat the prompt.
 */
export function sanitizePageContext(input: unknown): PageContext | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as PageContextInput;
  const cap = (s: string, n = 200) => (s.length > n ? s.slice(0, n) : s);

  const ctx: PageContext = {};
  const tab = cap(str(i.tab), 40);
  const stage = cap(str(i.stage), 40);
  const artifactType = cap(str(i.artifactType), 40);
  const artifactId = cap(str(i.artifactId));
  const artifactName = cap(str(i.artifactName));
  if (tab) ctx.tab = tab;
  if (stage) ctx.stage = stage;
  if (artifactType) ctx.artifactType = artifactType;
  if (artifactId) ctx.artifactId = artifactId;
  if (artifactName) ctx.artifactName = artifactName;

  if (i.extra && typeof i.extra === 'object' && !Array.isArray(i.extra)) {
    const extra: Record<string, string> = {};
    let n = 0;
    for (const [k, v] of Object.entries(i.extra as Record<string, unknown>)) {
      const val = str(v);
      if (val && n < 8) {
        extra[cap(k, 40)] = cap(val);
        n += 1;
      }
    }
    if (Object.keys(extra).length > 0) ctx.extra = extra;
  }

  // Nothing usable at all → null, so callers can cheaply skip the fold.
  return Object.keys(ctx).length > 0 ? ctx : null;
}

/**
 * Render the page-context preamble that grounds the assistant on the user's current
 * screen. Returns '' when there is nothing to say (so the caller adds nothing).
 *
 * The wording is deliberately imperative about the DEFAULT-subject rule: if an
 * artifact is open, act on it without re-asking for its id.
 */
export function renderPageContext(ctx: PageContext | null | undefined): string {
  if (!ctx) return '';
  const lines: string[] = [
    '--- WHERE THE USER IS RIGHT NOW (open on screen) ---',
    'This is the exact screen the user is looking at. Use it to ground your answer:',
  ];
  if (ctx.tab) lines.push(`• Tab: ${ctx.tab}`);
  if (ctx.stage) lines.push(`• Stage / step: ${ctx.stage}`);
  if (ctx.artifactType || ctx.artifactId || ctx.artifactName) {
    const type = ctx.artifactType ?? 'artifact';
    const name = ctx.artifactName ? `"${ctx.artifactName}"` : '(unnamed)';
    const id = ctx.artifactId ? ` [id: ${ctx.artifactId}]` : '';
    lines.push(`• Open ${type}: ${name}${id}`);
  }
  if (ctx.extra) {
    for (const [k, v] of Object.entries(ctx.extra)) lines.push(`• ${k}: ${v}`);
  }
  if (ctx.artifactId || ctx.artifactName) {
    lines.push(
      '',
      'DEFAULT SUBJECT: unless the user clearly names a different one, the artifact',
      'above IS the subject of their request. Act on it directly — do NOT ask for its',
      'id or name; you already have them here. (e.g. "document the columns" means',
      'document THIS open dataset.) Only ask if the request is genuinely ambiguous',
      'about which artifact, or needs details this snapshot does not carry.',
    );
  }
  return lines.join('\n');
}
