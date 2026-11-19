/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Confirm card's content — what a user is shown before the assistant's write runs.
 * USER STORY: As a user I want to read, in plain words, exactly what the assistant is about to
 *             do in my name — taken from the call the server is holding, not from what the model
 *             said it would do.
 * ARCHITECTURE:
 *   - Pure: no `server-only`, no store, no React. The server projects a stored confirmation
 *     through {@link describeConfirmation} and the client renders the result as text nodes.
 *   - EVERY field is derived from the tool NAME, the tool's own registry description and the
 *     STORED arguments. Nothing here ever sees model prose, so a model cannot title its own card.
 *   - Display only. Values are clipped and secret-looking keys are masked for the screen; the
 *     call that runs on Confirm is the server-held original, which this module never changes.
 */
import { holdReason } from '@tabs/agents/lib/build/hold';
import { isSessionAllowable } from '@core/mcp/tool-classes';

export type ConfirmCard = {
  confirmationId: string;
  /** The exact tool name, shown in monospace beside the plain title. */
  tool: string;
  /** Plain words for "The assistant wants to: …", e.g. "create dataset". */
  title: string;
  /** The tool's own description from the registry (first sentence), or '' when unknown. */
  description: string;
  /** Up to four arguments worth reading at a glance. Values are clipped and masked. */
  keyArgs: { name: string; value: string }[];
  /** Every argument, pretty-printed for the details toggle. Masked, and clipped when huge. */
  argsJson: string;
  /** What confirming means, in one or two sentences. */
  consequence: string;
  /** Delete / archive / retire: danger styling and a "cannot be undone" line. */
  danger: boolean;
  /** Whether "Allow for this conversation" may be offered — the server's answer, by tool name. */
  sessionAllowable: boolean;
  /** ISO time after which Confirm no longer works. */
  expiresAt: string;
};

/** Names whose plain title is not just the name with spaces. */
const TITLES: Readonly<Record<string, string>> = {
  delete: 'delete an app',
  archive: 'archive an app',
  retire: 'retire an artifact',
  commit: 'save a new version of an app',
  go_live: 'put a pipeline live',
  request_deploy: 'file a deploy request',
  request_promotion: 'ask for a promotion to Domain',
  request_certification: 'ask for a Company certification',
};

/** "create_dataset" → "create dataset". By own name only, so `constructor` is just a name. */
export function plainTitle(tool: string): string {
  if (Object.hasOwn(TITLES, tool)) return TITLES[tool];
  const words = tool.replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase();
  return words || 'run an unnamed tool';
}

/** Delete, archive and every retire: the calls a user cannot take back from the assistant. */
export function isDangerTool(tool: string): boolean {
  return /^(delete|archive|retire)(_|$)/.test(tool);
}

const SECRET_KEY = /pass(word)?|secret|token|credential|api[-_]?key|private[-_]?key|authorization/i;
const MASK = '••••••';

/** A display copy with secret-looking keys masked, at any depth. Never used for execution. */
export function maskForDisplay(value: unknown, depth = 0): unknown {
  if (depth > 8) return '…';
  if (Array.isArray(value)) return value.map((v) => maskForDisplay(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && v !== null && v !== undefined && v !== '' ? MASK : maskForDisplay(v, depth + 1);
    }
    return out;
  }
  return value;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The most of the pretty-printed arguments the details toggle is handed. */
export const MAX_CARD_ARGS_CHARS = 20_000;

const KEY_ARG_HINT = /^(name|title|id|.*Id|scope|domain|kind|type|path|ref|target|slug)$/;

function keyArgs(masked: Record<string, unknown>): { name: string; value: string }[] {
  const scalar = Object.entries(masked).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v) && v !== '');
  const hinted = scalar.filter(([k]) => KEY_ARG_HINT.test(k));
  const rest = scalar.filter(([k]) => !KEY_ARG_HINT.test(k));
  return [...hinted, ...rest].slice(0, 4).map(([name, v]) => ({ name, value: clip(String(v).replace(/\s+/g, ' '), 100) }));
}

/**
 * What confirming means. The scope wording is the hold gate's own (`holdReason`), so the card
 * and an agent run's approval card describe the same tool the same way — minus the part about a
 * second person, which is not true here: the user's own Confirm is sufficient, and whatever
 * review the tool itself opens downstream still happens.
 */
export function consequenceLine(tool: string): string {
  const base = 'It runs as you, with your own rights, only if you confirm.';
  if (isDangerTool(tool)) {
    const held = holdReason(tool);
    const why = held.label === 'always-confirmed' ? held.why.split(' — ').slice(1).join(' — ') : '';
    // The card itself leads with "This cannot be undone." for these; this line says why.
    return `${why ? `${why.charAt(0).toUpperCase()}${why.slice(1)}. ` : ''}${base}`;
  }
  const held = holdReason(tool);
  if (held.label === 'always-confirmed') {
    const why = held.why.split(' — ').slice(1).join(' — ');
    const downstream = /^request_/.test(tool) ? ' Your confirmation files the request; the review it opens is still decided by a person.' : '';
    return `${why.charAt(0).toUpperCase()}${why.slice(1)}.${downstream} ${base}`;
  }
  if (held.label === 'domain-scope') {
    return `It crosses the My → Domain boundary. The domain-admin step it leads to still applies. ${base}`;
  }
  return `Nothing has been changed yet. ${base}`;
}

function firstSentence(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  return clip(end >= 0 ? flat.slice(0, end + 1) : flat, 240);
}

/** Project one held call into the card the user decides on. */
export function describeConfirmation(input: {
  confirmationId: string;
  tool: string;
  args: Record<string, unknown>;
  expiresAt: string;
  /** The tool's registry description, when the caller has the registry at hand. */
  description?: string;
}): ConfirmCard {
  const masked = maskForDisplay(input.args ?? {}) as Record<string, unknown>;
  let argsJson: string;
  try {
    argsJson = JSON.stringify(masked, null, 2) ?? '{}';
  } catch {
    argsJson = '(the arguments could not be displayed)';
  }
  if (argsJson.length > MAX_CARD_ARGS_CHARS) {
    argsJson = `${argsJson.slice(0, MAX_CARD_ARGS_CHARS)}\n… (${argsJson.length - MAX_CARD_ARGS_CHARS} more characters not shown; the full arguments are held on the server and are what runs)`;
  }
  return {
    confirmationId: input.confirmationId,
    tool: input.tool,
    title: plainTitle(input.tool),
    description: input.description ? firstSentence(input.description) : '',
    keyArgs: keyArgs(masked),
    argsJson,
    consequence: consequenceLine(input.tool),
    danger: isDangerTool(input.tool),
    sessionAllowable: isSessionAllowable(input.tool),
    expiresAt: input.expiresAt,
  };
}

/** Accept only a well-formed card from the wire; anything else is dropped (client-side guard). */
export function parseConfirmCards(raw: unknown): ConfirmCard[] {
  if (!Array.isArray(raw)) return [];
  const out: ConfirmCard[] = [];
  for (const r of raw as Partial<ConfirmCard>[]) {
    if (!r || typeof r.confirmationId !== 'string' || typeof r.tool !== 'string' || typeof r.expiresAt !== 'string') continue;
    out.push({
      confirmationId: r.confirmationId,
      tool: r.tool,
      title: typeof r.title === 'string' && r.title ? r.title : plainTitle(r.tool),
      description: typeof r.description === 'string' ? r.description : '',
      keyArgs: Array.isArray(r.keyArgs)
        ? r.keyArgs.filter((k) => k && typeof k.name === 'string' && typeof k.value === 'string').slice(0, 4)
        : [],
      argsJson: typeof r.argsJson === 'string' ? r.argsJson : '{}',
      consequence: typeof r.consequence === 'string' ? r.consequence : '',
      danger: r.danger === true,
      // Only literal `true` offers the third button.
      sessionAllowable: r.sessionAllowable === true,
      expiresAt: r.expiresAt,
    });
  }
  return out;
}
