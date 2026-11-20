/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-53b N3 — identifier preflight over existing agent systems, and their migration
 * USER STORY: As the operator I want to know, before `AGENT_GRAPH_MODULE` goes on, which existing
 *             agent systems use an agent id, channel or tool name the strict token rule refuses,
 *             and I want a proposed rename for each that keeps the team working.
 * ARCHITECTURE:
 *   - `preflightDoc(yamlText)` reads a committed `system.yaml` (full or `form: os-layer`) as plain
 *     YAML — no `parseSystem`, so a definition the schema would refuse is still reported — and
 *     returns the identifier problems (`safe-ids.ts`).
 *   - `proposeIdMigration(sys)`: a pure rename. Each refused agent id becomes a safe token
 *     (lower case, `[a-z0-9_-]`, deduplicated, never reserved) and every reference follows:
 *     `entrypoint`, `members`, `edges`, `ui.positions`. Each refused channel name becomes a safe
 *     token and the `when` guards that read it are rewritten at the token level. A refused TOOL
 *     name is not renamed (it names a governed tool that does not exist): it is listed as
 *     `unresolved` for a person to fix. The result passes `identifierProblems` or says why not.
 *   - Read-only: nothing here writes. `scripts/agent-id-preflight.mjs` runs it over every domain
 *     repo; applying a proposal is an ordinary governed save of the new `system.yaml`.
 */
import { load } from 'js-yaml';
import type { System } from '@tabs/agents/lib/system-schema';
import { AGENT_ID_RE, CHANNEL_RE, identifierProblems, PROMPT_MAX_BYTES, TOOL_NAME_RE } from '@tabs/agents/lib/safe-ids';

const RESERVED = new Set(['__proto__', 'constructor', 'prototype', 'steps']);

type Doc = {
  entrypoint?: unknown;
  agents?: { id?: unknown; members?: unknown; tools?: unknown }[];
  grants?: { tools?: unknown };
  state?: { channels?: Record<string, unknown> };
};

/** The identifier problems of one committed `system.yaml`, read as plain YAML. */
export function preflightDoc(yamlText: string): string[] {
  let doc: Doc;
  try {
    doc = (load(yamlText) ?? {}) as Doc;
  } catch (e) {
    return [`system.yaml does not parse: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`];
  }
  const out: string[] = [];
  const bad = (what: string, v: unknown, re: RegExp) => {
    const s = String(v ?? '');
    if (!re.test(s) || RESERVED.has(s)) out.push(`${what} ${JSON.stringify(s)}`);
  };
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  for (const a of list(doc.agents) as Doc['agents'] & object[]) {
    bad('agent id', a?.id, AGENT_ID_RE);
    for (const m of list(a?.members)) bad('supervised member', m, AGENT_ID_RE);
    for (const t of list(a?.tools)) bad('tool', t, TOOL_NAME_RE);
  }
  for (const t of list(doc.grants?.tools)) bad('tool', t, TOOL_NAME_RE);
  for (const c of Object.keys(doc.state?.channels ?? {})) bad('state channel', c, CHANNEL_RE);
  if (doc.entrypoint !== undefined) bad('entrypoint', doc.entrypoint, AGENT_ID_RE);
  // The prompt cap (`PROMPT_MAX_BYTES`): a definition over it would be refused on its next save.
  for (const a of list(doc.agents) as { id?: unknown; agent_md?: unknown; memory_md?: unknown }[]) {
    for (const field of ['agent_md', 'memory_md'] as const) {
      const bytes = Buffer.byteLength(String(a?.[field] ?? ''), 'utf8');
      if (bytes > PROMPT_MAX_BYTES) out.push(`agent ${JSON.stringify(String(a?.id ?? ''))} ${field} is ${bytes} bytes (at most ${PROMPT_MAX_BYTES})`);
    }
  }
  return out;
}

function token(raw: string, re: RegExp, taken: Set<string>, fallback: string, allowDash: boolean): string {
  let t = String(raw ?? '').toLowerCase().replace(allowDash ? /[^a-z0-9_-]+/g : /[^a-z0-9_]+/g, allowDash ? '-' : '_').replace(/^[-_]+|[-_]+$/g, '');
  if (!t || !re.test(t)) t = `${fallback}_${t}`.replace(/_+$/, '');
  t = t.slice(0, 60);
  if (!re.test(t) || RESERVED.has(t)) t = `${fallback}_${t}`.slice(0, 60);
  let out = t;
  for (let i = 2; taken.has(out) || RESERVED.has(out); i += 1) out = `${t}_${i}`;
  taken.add(out);
  return out;
}

export type IdMigration = {
  system: System;
  agents: Record<string, string>;
  channels: Record<string, string>;
  unresolved: string[];
};

/** A pure rename of every refused agent id and channel, with all references updated. */
export function proposeIdMigration(input: System): IdMigration {
  const sys = structuredClone(input);
  const agents: Record<string, string> = {};
  const channels: Record<string, string> = {};
  const takenA = new Set(sys.agents.map((a) => a.id).filter((id) => AGENT_ID_RE.test(id) && !RESERVED.has(id)));
  for (const a of sys.agents) if (!AGENT_ID_RE.test(a.id) || RESERVED.has(a.id)) agents[a.id] = token(a.id, AGENT_ID_RE, takenA, 'agent', true);
  const takenC = new Set(Object.keys(sys.state.channels).filter((c) => CHANNEL_RE.test(c) && !RESERVED.has(c)));
  for (const c of Object.keys(sys.state.channels)) if (!CHANNEL_RE.test(c) || RESERVED.has(c)) channels[c] = token(c, CHANNEL_RE, takenC, 'ch', false);

  const ra = (id: string) => agents[id] ?? id;
  for (const a of sys.agents) {
    a.id = ra(a.id);
    if (a.members) a.members = a.members.map(ra);
  }
  if (sys.entrypoint) sys.entrypoint = ra(sys.entrypoint);
  for (const e of sys.edges) {
    e.from = ra(e.from);
    e.to = ra(e.to);
    if (e.when) {
      for (const [from, to] of Object.entries(channels)) {
        // Token-level: a channel reference is `state.<name>` or a bare identifier.
        const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        e.when = e.when.replace(new RegExp(`(^|[^A-Za-z0-9_.'"])(state\\.)?${esc}(?![A-Za-z0-9_])`, 'g'), (_m, pre: string, st: string | undefined) => `${pre}${st ?? ''}${to}`);
      }
    }
  }
  sys.state.channels = Object.fromEntries(Object.entries(sys.state.channels).map(([k, v]) => [channels[k] ?? k, v]));
  if (sys.ui?.positions) sys.ui.positions = Object.fromEntries(Object.entries(sys.ui.positions).map(([k, v]) => [ra(k), v]));
  if (sys.routing?.overrides) sys.routing.overrides = Object.fromEntries(Object.entries(sys.routing.overrides).map(([k, v]) => [ra(k), v]));
  const unresolved = identifierProblems(sys);
  return { system: sys, agents, channels, unresolved };
}
