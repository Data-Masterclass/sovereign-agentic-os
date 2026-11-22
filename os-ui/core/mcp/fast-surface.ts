/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       mcp
 * FEATURE:    The fast external MCP surface — a small CORE read toolset by default, named
 *             TOOLSETS on demand, compact paginated lists.
 * USER STORY: As someone asking Claude "which datasets do I have?" I want ONE tool call and a short
 *             answer, not 150 tool definitions and a mandatory whoami / list_capabilities / guide tour.
 * ARCHITECTURE:
 *   - This is a VIEW over the one registry, applied only on the external HTTP door
 *     (`HandleRpcOptions.fast`). Internal callers (agent runs, the Home chat, the UI) keep the full
 *     registry and the original payloads, byte for byte.
 *   - MCP mechanism (spec 2025-06-18, server/tools): `tools/list` is the live list, the server
 *     declares `tools.listChanged: true`, and sends `notifications/tools/list_changed` when a
 *     toolset is loaded. The set of loaded toolsets is per MCP session (`Mcp-Session-Id`), bound to
 *     the user who loaded it.
 *   - Governance is untouched: an unloaded tool is refused (`toolset_not_loaded`), a loaded tool
 *     still passes the role floor and its own governed function. Hiding is a convenience; the
 *     refusal is the control.
 *   - Pure: no `server-only`, no tab import, no registry import (server.ts imports this).
 */

/** The core read/find set: what everyday questions need. Everything else is in a toolset. */
export const CORE_TOOLS: readonly string[] = [
  'whoami', 'find', 'load_toolset', 'list_capabilities', 'get_guide',
  'list_datasets', 'get_dataset', 'query_data',
  'list_metrics', 'get_metric', 'query_metric',
  'list_files', 'search_files', 'get_file',
  'list_knowledge', 'get_knowledge', 'search_knowledge',
  'list_dashboards', 'list_agent_systems', 'get_agent_system',
  'list_software', 'list_connections', 'list_approvals',
];

/** Named toolsets the client enables on demand. */
export const TOOLSETS: Record<string, { title: string; description: string }> = {
  data: { title: 'Data', description: 'create, ingest, transform, document, quality-check, sync and promote datasets' },
  knowledge: { title: 'Knowledge', description: 'author, index, publish and retire knowledge (workflows and notes); OKF bundles' },
  files: { title: 'Files', description: 'upload files and reindex the corpus' },
  analytics: { title: 'Metrics & dashboards', description: 'define, preview and promote metrics; create dashboards' },
  agents: { title: 'Agents', description: 'create, build, run and resume agent systems' },
  software: { title: 'Software', description: 'design, build, preview, verify, deploy and retire apps' },
  connections: { title: 'Connections', description: 'create, test, configure, promote and retire connections; exposure sets; catalog' },
  governance: { title: 'Governance', description: 'approvals, certification, lineage, history, versions, go-live and retire' },
  platform: { title: 'Platform', description: 'monitoring, runs and traces, operating model, conversations, engineering view' },
};

const TAB_TOOLSET: Record<string, string> = {
  data: 'data',
  knowledge: 'knowledge',
  files: 'files',
  metrics: 'analytics',
  dashboards: 'analytics',
  agents: 'agents',
  software: 'software',
  connections: 'connections',
  governance: 'governance',
  monitoring: 'platform',
  'operating-manual': 'platform',
  meta: 'platform',
};

/** The toolset a tool lives in, or `null` for a core tool. A new tool is placed by its tab. */
export function toolsetOf(tool: { name: string; tab: string }): string | null {
  if (CORE_TOOLS.includes(tool.name)) return null;
  return TAB_TOOLSET[tool.tab] ?? 'platform';
}

/** The toolset a tab's write tools live in (used by the prompts to say what to load). */
export function toolsetForTab(tab: string): string | null {
  return TAB_TOOLSET[tab] && tab !== 'meta' ? TAB_TOOLSET[tab] : null;
}

// --------------------------------------------------------------------- per-session loaded toolsets
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 5000;
type Entry = { user: string; loaded: Set<string>; touched: number };
const sessions = new Map<string, Entry>();

function sweep(now: number): void {
  for (const [k, v] of sessions) if (now - v.touched > SESSION_TTL_MS) sessions.delete(k);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

/** The toolsets this session (bound to this user) has loaded. A key another user created is empty. */
export function loadedToolsets(sessionKey: string, userId: string): ReadonlySet<string> {
  const e = sessions.get(sessionKey);
  return e && e.user === userId ? e.loaded : new Set();
}

/** Mark a toolset loaded for this session. Returns false when the key belongs to another user. */
export function loadToolset(sessionKey: string, userId: string, name: string): boolean {
  const now = Date.now();
  sweep(now);
  const e = sessions.get(sessionKey);
  if (e && e.user !== userId) return false;
  const entry = e ?? { user: userId, loaded: new Set<string>(), touched: now };
  entry.loaded.add(name);
  entry.touched = now;
  sessions.delete(sessionKey);
  sessions.set(sessionKey, entry); // re-insert = most recently used
  return true;
}

export function __resetSessionsForTests(): void {
  sessions.clear();
}

// --------------------------------------------------------------------- compact lists
/** The artifact list tools that return a compact page by default on the fast door. */
export const COMPACT_LIST_TOOLS: readonly string[] = [
  'list_datasets', 'list_metrics', 'list_files', 'list_knowledge', 'list_dashboards',
  'list_agent_systems', 'list_software', 'list_connections',
];

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 200;

/** The three optional arguments every compact list tool advertises. */
export const LIST_PAGING_PROPS: Record<string, unknown> = {
  detail: { type: 'boolean', description: 'OPTIONAL. true returns the full records (large). Default: compact rows (id, name, domain, scope, status, updated). Or call the matching get_* tool for one record.' },
  limit: { type: 'number', description: `OPTIONAL. Rows per page (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
  offset: { type: 'number', description: 'OPTIONAL. Skip this many rows; use `nextOffset` from the previous page.' },
};

export function withListPaging<S extends { properties: Record<string, unknown>; examples?: unknown[] }>(schema: S): S {
  return { ...schema, properties: { ...schema.properties, ...LIST_PAGING_PROPS } };
}

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const SCOPE_OF_GROUP: Record<string, string> = { mine: 'my', domain: 'domain', marketplace: 'company' };
const SCOPE_OF_TIER = (t: string | undefined): string | undefined => {
  if (!t) return undefined;
  const w = t.toLowerCase();
  if (['personal', 'private', 'my', 'dataset', 'draft'].includes(w)) return undefined; // not an audience word
  if (['shared', 'domain'].includes(w)) return 'domain';
  if (['marketplace', 'company', 'certified'].includes(w)) return 'company';
  return undefined;
};

export type CompactItem = { id: string; name: string; domain?: string; scope?: string; status?: string; updated?: string };

/** One row → the compact projection. Tolerant of the stores' differing field names; never invents. */
export function compactRow(row: Row, groupScope?: string): CompactItem {
  const sys = isRow(row.system) ? row.system : {};
  const id = text(row.id) ?? text(row.metricId) ?? text(row.member) ?? text(row.slug) ?? text(row.systemId) ?? '';
  const name = text(row.name) ?? text(row.title) ?? text(sys.name) ?? text(row.label) ?? id;
  const domain = text(row.domain) ?? text(sys.domain);
  const scope = groupScope ?? text(row.audience) ?? SCOPE_OF_TIER(text(row.tier) ?? text(row.visibility));
  const status = text(row.lifecycle) ?? text(row.status);
  const updated = text(row.updatedAt) ?? text(row.updated) ?? text(row.modifiedAt) ?? text(row.createdAt);
  return {
    id, name,
    ...(domain ? { domain } : {}),
    ...(scope ? { scope } : {}),
    ...(status ? { status } : {}),
    ...(updated ? { updated } : {}),
  };
}

/** The pagination arguments, validated: a bad value is a 400 naming the argument. */
export function pagingArgs(args: Record<string, unknown>): { detail: boolean; limit: number; offset: number } {
  const bad = (m: string): never => { throw Object.assign(new Error(m), { status: 400 }); };
  const num = (k: string, dflt: number, min: number, max: number): number => {
    const v = args[k];
    if (v === undefined || v === null || v === '') return dflt;
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < min) return bad(`\`${k}\` must be an integer >= ${min}`);
    return Math.min(v, max);
  };
  return { detail: args.detail === true, limit: num('limit', DEFAULT_LIMIT, 1, MAX_LIMIT), offset: num('offset', 0, 0, Number.MAX_SAFE_INTEGER) };
}

/**
 * Flatten a list tool's payload (a flat array or the `{mine, domain, marketplace}` groups) to compact
 * rows, newest first, one page. A payload of another shape is returned unchanged — never guessed at.
 */
export function compactList(payload: unknown, args: Record<string, unknown>): unknown {
  const { limit, offset } = pagingArgs(args);
  const rows: CompactItem[] = [];
  let extras: Row = {};
  if (Array.isArray(payload)) {
    for (const r of payload) if (isRow(r)) rows.push(compactRow(r));
  } else if (isRow(payload) && Object.keys(SCOPE_OF_GROUP).some((g) => Array.isArray(payload[g]))) {
    for (const [group, scope] of Object.entries(SCOPE_OF_GROUP)) {
      const list = payload[group];
      if (Array.isArray(list)) for (const r of list) if (isRow(r)) rows.push(compactRow(r, scope));
    }
    // A short note a tool attached (e.g. list_files saying which folders exist) survives compaction.
    if (typeof payload.note === 'string') extras = { note: payload.note };
    if (Array.isArray(payload.availableFolders)) extras = { ...extras, availableFolders: payload.availableFolders };
  } else return payload;
  const sorted = rows.map((r, i) => ({ r, i })).sort((a, b) => (b.r.updated ?? '').localeCompare(a.r.updated ?? '') || a.i - b.i).map((x) => x.r);
  const page = sorted.slice(offset, offset + limit);
  const next = offset + page.length < sorted.length ? offset + page.length : null;
  return {
    total: sorted.length,
    offset,
    items: page,
    nextOffset: next,
    ...extras,
    hint: 'Compact rows. Pass detail:true for full records, or call the matching get_* tool for one; page with offset/limit.',
  };
}
