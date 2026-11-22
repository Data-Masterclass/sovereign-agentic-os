/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       mcp
 * FEATURE:    `find(query)` — one search across everything the caller can see; `load_toolset`.
 * USER STORY: As someone who asks "where is the thing about X?" I want ONE call that looks across
 *             datasets, KPIs, files, knowledge, workflows, dashboards, agents and software, instead
 *             of guessing which tab to open.
 * ARCHITECTURE:
 *   - `find` NEVER reads a store itself. It calls the SAME governed list/search tools a client
 *     could call one by one (`list_datasets`, `search_files`, `search_knowledge`, ...), as the
 *     caller, so row- and document-level security, domain isolation and the OPA retrieve gate are
 *     exactly the ones those tools already apply. A result is a projection of what they returned.
 *   - A source that fails or times out is REPORTED in `skipped` (with its reason), never silently
 *     dropped — "no match" and "could not look" are different answers.
 *   - Sources are a table: a tool that is not registered (e.g. a workflow tool on a build that does
 *     not have it) is skipped by name, so adding a source is one line and a removed tool cannot
 *     break the search.
 *   - `load_toolset` is stateful only on the external door; the dispatcher handles it there. On any
 *     other door every tool is already listed, and this tool says so.
 */
import 'server-only';
import type { McpTool } from '@core/mcp/server';
import { fail, str } from '@core/mcp/write-common';
import { TOOLSETS, compactRow, type CompactItem } from '@core/mcp/fast-surface';

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

type Source = {
  kind: string;
  tool: string;
  /** `list`: the tool returns rows, filtered here by the query. `search`: the tool searched already. */
  mode: 'list' | 'search';
  args: (query: string) => Record<string, unknown>;
  /** search mode: pull the hit rows out of the tool's result. */
  hits?: (result: unknown) => Row[];
};

const SOURCES: Source[] = [
  { kind: 'dataset', tool: 'list_datasets', mode: 'list', args: () => ({}) },
  { kind: 'metric', tool: 'list_metrics', mode: 'list', args: () => ({}) },
  { kind: 'file', tool: 'search_files', mode: 'search', args: (query) => ({ query }), hits: (r) => (isRow(r) && Array.isArray(r.hits) ? r.hits.filter(isRow) : []) },
  { kind: 'knowledge', tool: 'list_knowledge', mode: 'list', args: () => ({}) },
  {
    kind: 'knowledge', tool: 'search_knowledge', mode: 'search', args: (query) => ({ query, k: 8 }),
    hits: (r) => (isRow(r) && Array.isArray(r.hits) ? r.hits.filter(isRow).map(knowledgeHitRow) : []),
  },
  // A tool that does not exist on this build is skipped by name (see header).
  { kind: 'workflow', tool: 'list_workflows', mode: 'list', args: () => ({}) },
  { kind: 'dashboard', tool: 'list_dashboards', mode: 'list', args: () => ({}) },
  { kind: 'agent', tool: 'list_agent_systems', mode: 'list', args: () => ({}) },
  { kind: 'software', tool: 'list_software', mode: 'list', args: () => ({}) },
];

const KINDS = [...new Set(SOURCES.map((s) => s.kind))];
const SOURCE_TIMEOUT_MS = 10_000;
const DEFAULT_FIND_LIMIT = 20;

/** A retrieval hit → a row `compactRow` understands (unit id, the owning workflow, a short snippet). */
function knowledgeHitRow(hit: Row): Row {
  const unit = isRow(hit.unit) ? hit.unit : hit;
  const prov = isRow(unit.provenance) ? unit.provenance : {};
  const snippet = typeof unit.text === 'string' ? unit.text.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  return {
    id: prov.workflowId ?? unit.id ?? hit.id,
    name: prov.title ?? prov.workflowName ?? (snippet || undefined),
    domain: prov.domain,
    status: prov.type,
    updatedAt: prov.updatedAt,
  };
}

const TEXT_FIELDS = ['id', 'name', 'title', 'description', 'purpose', 'folder', 'slug', 'domain', 'owner', 'dataset', 'summary'];

function haystack(row: Row): string {
  const sys = isRow(row.system) ? row.system : {};
  const parts: string[] = [];
  for (const f of TEXT_FIELDS) if (typeof row[f] === 'string') parts.push(row[f] as string);
  for (const f of ['name', 'description', 'domain']) if (typeof sys[f] === 'string') parts.push(sys[f] as string);
  if (Array.isArray(row.tags)) parts.push(...row.tags.filter((t): t is string => typeof t === 'string'));
  return parts.join(' ').toLowerCase();
}

function flatten(payload: unknown): { row: Row; scope?: string }[] {
  if (Array.isArray(payload)) return payload.filter(isRow).map((row) => ({ row }));
  if (!isRow(payload)) return [];
  const out: { row: Row; scope?: string }[] = [];
  for (const [group, scope] of [['mine', 'my'], ['domain', 'domain'], ['marketplace', 'company']] as const) {
    const list = payload[group];
    if (Array.isArray(list)) for (const row of list) if (isRow(row)) out.push({ row, scope });
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

export type FindResult = CompactItem & { kind: string };

export const FIND_TOOLS: McpTool[] = [
  {
    name: 'find',
    tab: 'meta',
    minRole: 'creator',
    description:
      'Search EVERYTHING you can see in one call — datasets, KPIs, files, knowledge notes, workflows, dashboards, agents and software — and get compact hits (kind, id, name, domain, scope, status, updated). Use it when you do not know which tab holds something; for a plain list ("my datasets") call the matching list_* tool instead. Governance: runs the same governed list/search tools as you, so you only ever see what you are entitled to.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, e.g. "refund policy". Every word must match.' },
        kinds: { type: 'array', items: { type: 'string', enum: KINDS }, description: `OPTIONAL. Limit to some kinds: ${KINDS.join(', ')}.` },
        limit: { type: 'number', description: `OPTIONAL. Max hits (default ${DEFAULT_FIND_LIMIT}).` },
      },
      required: ['query'],
      examples: [{ query: 'refund' }, { query: 'churn', kinds: ['metric', 'dashboard'] }],
    },
    call: async (user, args) => {
      const query = str(args.query).trim();
      if (!query) fail('find needs a `query`', 400);
      const wanted = Array.isArray(args.kinds) ? args.kinds.filter((k): k is string => typeof k === 'string') : [];
      const unknown = wanted.filter((k) => !KINDS.includes(k));
      if (unknown.length) fail(`unknown kind(s): ${unknown.join(', ')} — valid: ${KINDS.join(', ')}`, 400);
      const limit = typeof args.limit === 'number' && args.limit >= 1 ? Math.min(Math.floor(args.limit), 100) : DEFAULT_FIND_LIMIT;
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

      // Late import: server.ts imports this module via the registry.
      const { ALL_MCP_TOOLS, roleCanUse } = await import('@core/mcp/server');
      const sources = SOURCES.filter((s) => wanted.length === 0 || wanted.includes(s.kind));

      const settled = await Promise.all(sources.map(async (s) => {
        const tool = ALL_MCP_TOOLS.find((t) => t.name === s.tool);
        if (!tool) return { s, skipped: 'tool not available on this build' as string | null, found: [] as FindResult[] };
        if (!roleCanUse(user.role, tool.minRole)) return { s, skipped: `requires ${tool.minRole}`, found: [] as FindResult[] };
        try {
          const result = await withTimeout(tool.call(user, s.args(query)), SOURCE_TIMEOUT_MS);
          const found: FindResult[] = [];
          if (s.mode === 'list') {
            for (const { row, scope } of flatten(result)) {
              const h = haystack(row);
              if (tokens.every((t) => h.includes(t))) found.push({ kind: s.kind, ...compactRow(row, scope) });
            }
          } else {
            for (const row of s.hits?.(result) ?? []) found.push({ kind: s.kind, ...compactRow(row) });
          }
          return { s, skipped: null, found };
        } catch (e) {
          return { s, skipped: (e as Error).message || 'failed', found: [] as FindResult[] };
        }
      }));

      // De-duplicate (a workflow found by list and by search is one hit), newest first.
      const seen = new Set<string>();
      const all: FindResult[] = [];
      for (const { found } of settled) for (const f of found) {
        const key = `${f.kind}:${f.id}`;
        if (f.id && seen.has(key)) continue;
        seen.add(key);
        all.push(f);
      }
      all.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
      const skipped = settled.filter((x) => x.skipped).map((x) => ({ kind: x.s.kind, tool: x.s.tool, reason: x.skipped as string }));
      return {
        query,
        total: all.length,
        results: all.slice(0, limit),
        ...(all.length > limit ? { truncated: true } : {}),
        ...(skipped.length ? { skipped } : {}),
      };
    },
  },
  {
    name: 'load_toolset',
    tab: 'meta',
    minRole: 'creator',
    description:
      `Load a named toolset so its tools appear in the tool list (the server then sends a tool-list-changed notification). The default list is a small read/find core; building, promoting and administering tools live in toolsets: ${Object.keys(TOOLSETS).join(', ')}. Call it only when you are about to BUILD, change or promote something. Governance: loading changes nothing about what you may do — every tool still runs as you, role-gated, policy-checked and audited.`,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', enum: Object.keys(TOOLSETS), description: 'The toolset to load.' } },
      required: ['name'],
      examples: [{ name: 'data' }],
    },
    call: async () => ({
      note: 'This connection already lists every tool; there is nothing to load.',
      toolsets: Object.fromEntries(Object.entries(TOOLSETS).map(([k, v]) => [k, v.description])),
    }),
  },
];
