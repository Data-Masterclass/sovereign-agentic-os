/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Home chat view logic — plain-language errors, live event stream, secret masking, artifact links
 * USER STORY: As a user I want a refusal explained in plain words with the next step, steps that appear
 *             as they happen, no secret echoed on a confirmation card, and results that open the real artifact.
 * ARCHITECTURE:
 *   - Pure, no I/O, no React: `tabs/home/ui/HomeChat.tsx` only maps these onto elements.
 *   - Typed errors are the server's own `{ code, reason, hint }`; this only rewrites them for reading.
 *   - Links come from a fixed route map; nothing model-supplied becomes an href.
 */

export type TypedError = { code: string; reason: string; hint: string };

const ROLE_WORDS: Record<string, string> = {
  creator: 'creator',
  builder: 'builder',
  domain_admin: 'domain admin',
  admin: 'admin',
};

/** Raw role ids to words, anywhere in a sentence. */
function words(text: string): string {
  return text.replace(/\b(domain_admin|builder|creator|admin)\b/g, (m) => ROLE_WORDS[m] ?? m);
}

/** A typed refusal as one or two plain sentences: what happened, and who or what to ask. */
export function plainError(e: TypedError): string {
  const hint = words(e.hint || '').trim();
  switch (e.code) {
    case 'forbidden': {
      const need = /requires (\w+)/.exec(e.reason)?.[1];
      const role = need ? (ROLE_WORDS[need] ?? need) : null;
      const first = role
        ? `This needs the ${role} role, and yours does not allow it.`
        : 'You are not allowed to do this.';
      const ask = role && role !== 'creator' ? ` Ask a ${role} to do it, or keep the work in your own space.` : hint ? ` ${hint}` : '';
      return `${first}${ask}`;
    }
    case 'not_found':
      return `I could not find that. ${hint}`.trim();
    case 'conflict':
      return `That is not possible in the item's current state. ${words(e.reason)}`.trim();
    case 'bad_request':
      return `Something in the request was not valid: ${words(e.reason)}`;
    case 'upstream_error':
    case 'engine_unavailable':
      return `A platform component is not reachable right now, so nothing was changed or invented. ${hint}`.trim();
    default:
      return `${words(e.reason)}${hint ? ` ${hint}` : ''}`.trim();
  }
}

export type StreamEvent = { type: string; [k: string]: unknown };

/**
 * Split an NDJSON chunk into whole events; the unfinished tail is returned as `rest` for the next
 * chunk. A line that is not JSON is dropped, never rendered.
 */
export function parseStreamLines(rest: string, chunk: string): { events: StreamEvent[]; rest: string; dropped: number } {
  const lines = (rest + chunk).split('\n');
  const tail = lines.pop() ?? '';
  const events: StreamEvent[] = [];
  let dropped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let v: StreamEvent | null = null;
    try {
      v = JSON.parse(line) as StreamEvent;
    } catch {
      dropped += 1; // counted, never rendered
    }
    if (v && typeof v.type === 'string') events.push(v);
    else if (v) dropped += 1;
  }
  return { events, rest: tail, dropped };
}

/**
 * The quiet status line a `status` event carries (e.g. "The model is busy — retrying…"), or null for
 * any other event. A status is not an error: the turn is still running.
 */
export function streamStatusText(ev: StreamEvent): string | null {
  if (ev.type !== 'status') return null;
  return typeof ev.message === 'string' && ev.message.trim() ? ev.message.trim() : null;
}

const SECRET_KEY = /(secret|password|passwd|token|api[_-]?key|credential|private[_-]?key|authorization)/i;

/** The arguments of a parked write, for the confirmation card, with secret-looking values masked. */
export function confirmCardArgs(args: unknown): unknown {
  if (Array.isArray(args)) return args.map(confirmCardArgs);
  if (args && typeof args === 'object') {
    return Object.fromEntries(
      Object.entries(args as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) ? '••••' : confirmCardArgs(v)]),
    );
  }
  return args;
}

/** A mail write's tool name: `m365__<connectionId>__mail_send` / `__mail_draft`. */
const MAIL_TOOL = /^m365__[A-Za-z0-9_-]{1,64}?__mail_(send|draft)$/;

/** The whole message a parked mail write would send or draft, for the confirm card. Never cut. */
export type MailPreview = { kind: 'send' | 'draft'; to: string[]; cc: string[]; subject: string | null; body: string; replyTo: string | null; thread?: { subject: string; from: string } };

/** The thread a reply goes to, from the display-only context the server looked up (never from the model). */
function threadOf(context: Record<string, unknown> | undefined): { thread?: { subject: string; from: string } } {
  const t = context?.thread as { subject?: unknown; from?: unknown } | undefined;
  return t && typeof t === 'object' ? { thread: { subject: typeof t.subject === 'string' ? t.subject : '', from: typeof t.from === 'string' ? t.from : '' } } : {};
}

/**
 * The confirm card's view of a parked `mail_send` / `mail_draft`: To, Cc, Subject and the FULL body as
 * plain text (the card renders it as text, never markup), so the user reads exactly what goes out. Null
 * for any other tool. These are the stored arguments the confirmation runs with, not a re-render.
 */
export function mailPreviewOf(tool: string, args: Record<string, unknown>, context?: Record<string, unknown>): MailPreview | null {
  const m = MAIL_TOOL.exec(tool);
  if (!m) return null;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);
  const reply = typeof args.replyToMessageId === 'string' && args.replyToMessageId.trim() ? args.replyToMessageId.trim() : null;
  if (list(args.to).length === 0 && typeof args.body !== 'string') return null; // no stored message (e.g. a card reloaded after it closed)
  return {
    kind: m[1] === 'send' ? 'send' : 'draft',
    to: list(args.to),
    cc: list(args.cc),
    subject: reply ? null : typeof args.subject === 'string' ? args.subject : '',
    body: typeof args.body === 'string' ? args.body : '',
    replyTo: reply,
    ...(reply ? threadOf(context) : {}),
  };
}

const KIND_TAB: Record<string, string> = {
  dataset: '/data',
  metric: '/metrics',
  dashboard: '/dashboards',
  knowledge: '/knowledge',
  file: '/unstructured',
  connection: '/connections',
  agent: '/agents',
  software: '/software',
};

/** Link to the real artifact in its own tab (`?focus=<id>`), or null for a kind with no page. */
export function artifactLink(kind: string, id: string): string | null {
  const tab = Object.hasOwn(KIND_TAB, kind) ? KIND_TAB[kind] : null;
  return tab && id ? `${tab}?focus=${encodeURIComponent(id)}` : null;
}

/** Starter prompts on the empty state; each is a plain request the governed tools can answer. */
export const STARTERS: readonly { label: string; prompt: string }[] = [
  { label: 'What data do I have?', prompt: 'What data products and files can I use right now?' },
  { label: 'Show my KPIs', prompt: 'List the KPIs in my domain and their latest values.' },
  { label: 'Search our knowledge', prompt: 'Search our knowledge for how we onboard a new customer.' },
  { label: 'What can I do here?', prompt: 'What can I do in this OS with my role?' },
];

const CREATES: Record<string, { kind: string; label: string }> = {
  create_dataset: { kind: 'dataset', label: 'data product' },
  define_metric: { kind: 'metric', label: 'KPI' },
  create_dashboard: { kind: 'dashboard', label: 'dashboard' },
  create_agent_system: { kind: 'agent', label: 'agent' },
  save_knowledge_note: { kind: 'knowledge', label: 'knowledge note' },
  upload_file: { kind: 'file', label: 'file' },
  create_software: { kind: 'software', label: 'app' },
  create_connection: { kind: 'connection', label: 'connection' },
};

/** After a create tool ran: where the new artifact lives, read from the tool's own JSON result. */
export function linkForResult(tool: string, resultText: string | undefined): { href: string; label: string } | null {
  const c = Object.hasOwn(CREATES, tool) ? CREATES[tool] : null;
  if (!c || !resultText) return null;
  let j: Record<string, unknown> | null = null;
  let readable = true;
  try {
    j = JSON.parse(resultText) as Record<string, unknown>;
  } catch {
    readable = false; // not JSON: there is no id to link to
  }
  if (!readable || !j) return null;
  const inner = (j[c.kind] ?? j.metric ?? j.result) as Record<string, unknown> | undefined;
  const id = [j.id, j[`${c.kind}Id`], inner?.id].find((v): v is string => typeof v === 'string' && v.length > 0);
  const href = id ? artifactLink(c.kind, id) : null;
  return href ? { href, label: `Open the ${c.label}` } : null;
}

/** The chat tool name of an account tool: `<provider>__<connectionId>__<tool>`. */
const ACCOUNT_TOOL = /^(notion|m365|onedrive|gdrive)__([A-Za-z0-9_-]{1,64}?)__[A-Za-z0-9_.-]+$/;
const PROVIDER_WORD: Record<string, string> = { notion: 'Notion', m365: 'Microsoft 365', onedrive: 'OneDrive', gdrive: 'Google Drive' };

/** `action`: the button text; `note`: the line beside it. */
export type ConnectCard = { connectionId: string; label: string; href: string; action: string; note: string };

/**
 * The "Connect your account" cards a turn needs: one per account connection whose call answered
 * `needs_connect`. The href is built from the step's own tool name (a validated connection id) and a
 * fixed route, never from model text. `returnTo` brings the user back to the chat.
 */
export function connectCards(steps: { name: string; error?: { code: string } }[] | undefined, returnTo = '/'): ConnectCard[] {
  const out: ConnectCard[] = [];
  for (const s of steps ?? []) {
    if (s.error?.code !== 'needs_connect') continue;
    const m = ACCOUNT_TOOL.exec(s.name);
    if (!m || out.some((c) => c.connectionId === m[2])) continue;
    const label = PROVIDER_WORD[m[1]] ?? m[1];
    // A mail write that answered needs_connect: the sign-in lacks the mail permissions (or is missing).
    const mail = MAIL_TOOL.test(s.name);
    out.push({
      connectionId: m[2],
      label,
      href: `/api/connections/connect?connectionId=${encodeURIComponent(m[2])}&returnTo=${encodeURIComponent(returnTo)}`,
      action: mail ? 'Reconnect to allow sending' : `Connect your ${label} account`,
      note: mail
        ? `Drafting and sending mail needs your own ${label} sign-in with the two mail permissions. Sign in once more and accept them; nothing was sent.`
        : `This needs your own ${label} sign-in. The OS keeps it on the server and uses it only for you.`,
    });
  }
  return out;
}
