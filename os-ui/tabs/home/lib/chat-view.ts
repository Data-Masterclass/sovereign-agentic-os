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
export function parseStreamLines(rest: string, chunk: string): { events: StreamEvent[]; rest: string } {
  const lines = (rest + chunk).split('\n');
  const tail = lines.pop() ?? '';
  const events: StreamEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as StreamEvent;
      if (v && typeof v.type === 'string') events.push(v);
    } catch { /* not an event */ }
  }
  return { events, rest: tail };
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
  try {
    const j = JSON.parse(resultText) as Record<string, unknown>;
    const inner = (j[c.kind] ?? j.metric ?? j.result) as Record<string, unknown> | undefined;
    const id = [j.id, j[`${c.kind}Id`], inner?.id].find((v): v is string => typeof v === 'string' && v.length > 0);
    const href = id ? artifactLink(c.kind, id) : null;
    return href ? { href, label: `Open the ${c.label}` } : null;
  } catch {
    return null;
  }
}
