/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * "Context actually used per run" (#177).
 *
 * Agents in this OS discover their context at RUNTIME — there is no pre-injected
 * context pack. So the honest record of what an agent consumed is its OWN tool
 * calls: which datasets it read, which knowledge units it retrieved, which files
 * it opened, which metrics/connections it touched, and which artifacts it wrote.
 * That trace is ALREADY captured per node in `LastRun.nodes[].steps[]` as
 * `{ tool, args, result, isError }`. This module is pure derive-and-surface over
 * that trace — no executor re-plumbing.
 *
 * HONESTY RULES this module enforces:
 *  - `confidence: 'captured'` — the id came straight from the tool's own `args`
 *    (e.g. `get_dataset(datasetId)`). `'inferred'` — we guessed it (e.g. parsed a
 *    physical FQN out of raw `query_data` SQL); it may be imprecise.
 *  - `errored: true` — the tool CALL failed (governance block or exec error), so the
 *    context was NOT actually obtained. Surfaced, never silently dropped.
 *  - `name` is BEST-EFFORT from the tool RESULT and may be absent (results are
 *    truncated for size, so a name can legitimately be missing).
 *  - Truncated results can UNDER-count retrieved ids — the roll-up is a floor.
 */

/** Which OS tab / artifact class a used-context entry belongs to. */
export type ContextKind = 'data' | 'knowledge' | 'files' | 'metrics' | 'connections';

/** How the context was engaged. */
export type ContextMode = 'read' | 'retrieved' | 'written';

/** Whether the id was captured from args or inferred (e.g. parsed from SQL). */
export type ContextConfidence = 'captured' | 'inferred';

/** One artifact this run actually touched. */
export type ContextItem = {
  kind: ContextKind;
  id: string;
  /** Best-effort human name, read from the tool result. May be absent. */
  name?: string;
  /** The tool that touched it (e.g. `get_dataset`, `query_data`). */
  via: string;
  mode: ContextMode;
  confidence: ContextConfidence;
  /** True when the tool call itself failed — the context was NOT obtained. */
  errored?: boolean;
  /**
   * A route to open this artifact in the OS (same-app link), or undefined when the
   * id can't be resolved to a navigable item (e.g. an inferred SQL FQN with no
   * registry id). See `deepLinkFor`.
   */
  deepLink?: string;
  /**
   * A short, human "how it was used" hint pulled cheaply from the step — e.g. the
   * SQL/query text or a knowledge query. Never a raw blob; capped and single-line.
   */
  hint?: string;
};

/** The per-agent slice of context usage — one entry per node that touched anything. */
export type NodeContextUsage = { node: string; items: ContextItem[] };

/** The derived per-run context-usage record. */
export type RunContextUsage = {
  items: ContextItem[];
  /** Roll-up: ids per kind (deduped, successful reads/retrievals/writes only). */
  byKind: Record<ContextKind, string[]>;
};

/** The minimal step shape this module reads — args may be an object OR a JSON string. */
export type UsageStep = {
  tool: string;
  args?: Record<string, unknown> | string;
  result?: string;
  isError?: boolean;
};

/** The minimal node shape — an (optional) agent name + its list of steps. */
export type UsageNode = { node?: string; steps?: UsageStep[] };

// ---------------------------------------------------------------- deep links

/**
 * The five context kinds are SINGLE-PAGE tabs in this OS (verified against
 * `lib/core/tabs.ts`: /data, /knowledge, /unstructured, /metrics, /connections) —
 * none has a per-item `[id]` route (only Big Bets and Software do). So the honest
 * deep link is the real tab route carrying the item id as a `?focus=<id>` param: it
 * always resolves to the CORRECT tab, never fabricates a wrong page, and gives the
 * tab a hook to auto-open the item. `data:sql` (an opaque inferred touch) and
 * inferred physical FQNs have no registry id → no link is produced for them.
 */
const KIND_ROUTE: Record<ContextKind, string> = {
  data: '/data',
  knowledge: '/knowledge',
  files: '/unstructured',
  metrics: '/metrics',
  connections: '/connections',
};

/** True for ids that don't name a real registry artifact (opaque / physical FQN). */
function isUnlinkableId(id: string): boolean {
  return id === 'data:sql' || id.includes('.'); // FQNs like iceberg.sales.gold_orders
}

/** A same-app route that opens this artifact, or undefined when it isn't resolvable. */
export function deepLinkFor(kind: ContextKind, id: string): string | undefined {
  if (!id || isUnlinkableId(id)) return undefined;
  const route = KIND_ROUTE[kind];
  return route ? `${route}?focus=${encodeURIComponent(id)}` : undefined;
}

// ---------------------------------------------------------------- how-it-was-used hint

/** One-line, capped snippet of a string — no raw blobs in the UI. */
function clip(s: string, max = 120): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * A short "how it was used" hint, cheaply from the step's own args — the SQL for a
 * query, the search query for a retrieval. Returns undefined when nothing legible is
 * cheaply available (we never fabricate). Result blobs are deliberately NOT dumped.
 */
function hintFrom(tool: string, args: Record<string, unknown>): string | undefined {
  const q =
    strField(args, 'sql') ??
    strField(args, 'query') ??
    strField(args, 'question') ??
    strField(args, 'prompt');
  return q ? clip(q) : undefined;
}

// ---------------------------------------------------------------- tool → extraction

/** Read-tools that carry the artifact id directly in a single arg field. */
const ID_ARG: Record<string, { field: string; kind: ContextKind; mode: ContextMode }> = {
  // Data (read)
  get_dataset: { field: 'datasetId', kind: 'data', mode: 'read' },
  profile_dataset: { field: 'datasetId', kind: 'data', mode: 'read' },
  build_gold_join: { field: 'datasetId', kind: 'data', mode: 'read' },
  use_data: { field: 'datasetId', kind: 'data', mode: 'read' },
  use_as_data: { field: 'datasetId', kind: 'data', mode: 'read' },
  // Knowledge (read a specific unit)
  get_knowledge: { field: 'knowledgeId', kind: 'knowledge', mode: 'read' },
  use_knowledge: { field: 'knowledgeId', kind: 'knowledge', mode: 'read' },
  // Files (read)
  get_file: { field: 'fileId', kind: 'files', mode: 'read' },
  read_app_files: { field: 'fileId', kind: 'files', mode: 'read' },
  // Metrics (read)
  query_metric: { field: 'metricId', kind: 'metrics', mode: 'read' },
  get_metric: { field: 'metricId', kind: 'metrics', mode: 'read' },
  // Connections (read/test)
  use_connection: { field: 'connectionId', kind: 'connections', mode: 'read' },
  test_connection: { field: 'connectionId', kind: 'connections', mode: 'read' },
};

/** search_* tools: the touched ids live in the RESULT, as retrievals. */
const SEARCH_RESULT: Record<string, ContextKind> = {
  search_knowledge: 'knowledge',
  search_files: 'files',
};

/** Write tools → the artifact kind + which arg field names the write target. */
const WRITE_TARGET: Record<string, { fields: string[]; kind: ContextKind }> = {
  create_dataset: { fields: ['datasetId', 'id', 'name'], kind: 'data' },
  add_dataset_version: { fields: ['datasetId', 'id'], kind: 'data' },
  ingest_dataset: { fields: ['datasetId', 'id'], kind: 'data' },
  transform_silver: { fields: ['datasetId', 'id'], kind: 'data' },
  document_dataset: { fields: ['datasetId', 'id'], kind: 'data' },
  author_knowledge: { fields: ['knowledgeId', 'id'], kind: 'knowledge' },
  publish_knowledge: { fields: ['knowledgeId', 'id'], kind: 'knowledge' },
  index_knowledge: { fields: ['knowledgeId', 'id'], kind: 'knowledge' },
  upload_file: { fields: ['fileId', 'id', 'path'], kind: 'files' },
  commit_agent_files: { fields: ['fileId', 'id'], kind: 'files' },
  define_metric: { fields: ['metricId', 'id'], kind: 'metrics' },
  create_connection: { fields: ['connectionId', 'id'], kind: 'connections' },
};

// ---------------------------------------------------------------- parsing helpers

/** Coerce a step's `args` into an object — tolerating a JSON-string (persisted form). */
function argsObject(args: UsageStep['args']): Record<string, unknown> {
  if (!args) return {};
  if (typeof args === 'string') {
    try {
      const p = JSON.parse(args);
      return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return args;
}

/** A trimmed string arg, or undefined. */
function strField(obj: Record<string, unknown>, field: string): string | undefined {
  const v = obj[field];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Best-effort parse of a (possibly truncated) JSON result string. */
function parseResult(result?: string): unknown {
  if (!result) return undefined;
  try {
    return JSON.parse(result);
  } catch {
    return undefined;
  }
}

/**
 * Extract physical FQN(s) — `iceberg.<schema>.<table>` — from raw query_data SQL.
 * query_data takes SQL, not a datasetId, so this is the honest best we can do
 * WITHOUT re-plumbing the executor (Phase 3, deliberately skipped): the touch is
 * always marked `confidence: 'inferred'`.
 */
function fqnsFromSql(sql: string): string[] {
  const out = new Set<string>();
  const re = /\b([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) out.add(m[1]);
  return [...out];
}

/**
 * Pull retrieved ids (+ best-effort names) out of a search_* result. Tolerates the
 * governed hit shape `{ hits: [{ id, title }] }` and a bare array. Truncated results
 * simply yield fewer hits — never an error (documented under-count).
 */
function searchHits(result: unknown): { id: string; name?: string }[] {
  const rows = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && Array.isArray((result as { hits?: unknown }).hits)
      ? ((result as { hits: unknown[] }).hits)
      : [];
  const out: { id: string; name?: string }[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id : typeof rec.fileId === 'string' ? rec.fileId : undefined;
    if (!id) continue;
    const name =
      typeof rec.title === 'string' ? rec.title : typeof rec.name === 'string' ? rec.name : undefined;
    out.push(name ? { id, name } : { id });
  }
  return out;
}

/** Best-effort name for an id-arg tool, read from its result envelope. */
function nameFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const rec = result as Record<string, unknown>;
  for (const f of ['name', 'title', 'label']) {
    if (typeof rec[f] === 'string' && (rec[f] as string).trim()) return (rec[f] as string).trim();
  }
  return undefined;
}

// ---------------------------------------------------------------- the derivation

/**
 * Derive what a run ACTUALLY consumed from its per-node tool trace. Pure: same
 * input → same output, no I/O. Works on both the live team runs (args as objects)
 * and the persisted `LastRun.nodes` (args as JSON strings) — the client can re-run
 * it as a fallback for runs recorded before this shipped.
 */
export function deriveContextUsage(nodes: UsageNode[]): RunContextUsage {
  const items: ContextItem[] = [];

  for (const node of nodes ?? []) {
    for (const step of node.steps ?? []) {
      const tool = step.tool;
      const args = argsObject(step.args);
      const errored = !!step.isError;
      const result = parseResult(step.result);

      const hint = hintFrom(tool, args);

      // 1) Direct id-arg reads.
      const idArg = ID_ARG[tool];
      if (idArg) {
        const id = strField(args, idArg.field);
        if (id) {
          const name = nameFromResult(result);
          const deepLink = deepLinkFor(idArg.kind, id);
          items.push({
            kind: idArg.kind,
            id,
            ...(name ? { name } : {}),
            via: tool,
            mode: idArg.mode,
            confidence: 'captured',
            ...(errored ? { errored: true } : {}),
            ...(deepLink ? { deepLink } : {}),
            ...(hint ? { hint } : {}),
          });
        }
        continue;
      }

      // 2) search_* → retrieved ids from the result (only when it succeeded).
      const searchKind = SEARCH_RESULT[tool];
      if (searchKind) {
        if (!errored) {
          for (const hit of searchHits(result)) {
            const deepLink = deepLinkFor(searchKind, hit.id);
            items.push({
              kind: searchKind,
              id: hit.id,
              ...(hit.name ? { name: hit.name } : {}),
              via: tool,
              mode: 'retrieved',
              confidence: 'captured',
              ...(deepLink ? { deepLink } : {}),
              ...(hint ? { hint } : {}),
            });
          }
        }
        continue;
      }

      // 3) query_data → infer dataset FQN(s) from the SQL, else an opaque touch.
      //    (Inferred FQNs / the opaque touch have no registry id → no deep link.)
      if (tool === 'query_data') {
        const sql = strField(args, 'sql') ?? '';
        const fqns = fqnsFromSql(sql);
        if (fqns.length > 0) {
          for (const fqn of fqns) {
            items.push({
              kind: 'data',
              id: fqn,
              via: tool,
              mode: 'read',
              confidence: 'inferred',
              ...(errored ? { errored: true } : {}),
              ...(hint ? { hint } : {}),
            });
          }
        } else {
          items.push({
            kind: 'data',
            id: 'data:sql',
            via: tool,
            mode: 'read',
            confidence: 'inferred',
            ...(errored ? { errored: true } : {}),
            ...(hint ? { hint } : {}),
          });
        }
        continue;
      }

      // 4) Write tools that ran → the write TARGET id.
      const write = WRITE_TARGET[tool];
      if (write) {
        let id: string | undefined;
        for (const f of write.fields) {
          id = strField(args, f);
          if (id) break;
        }
        if (id) {
          const name = nameFromResult(result);
          const deepLink = deepLinkFor(write.kind, id);
          items.push({
            kind: write.kind,
            id,
            ...(name ? { name } : {}),
            via: tool,
            mode: 'written',
            confidence: 'captured',
            ...(errored ? { errored: true } : {}),
            ...(deepLink ? { deepLink } : {}),
            ...(hint ? { hint } : {}),
          });
        }
      }
    }
  }

  return { items, byKind: rollUp(items) };
}

/**
 * Per-agent context usage — the SAME derivation applied per node, so the panel can
 * show, FOR EACH AGENT, exactly what that agent read/retrieved/wrote (not one merged
 * list). Nodes that touched nothing are omitted. Node order is preserved; an unnamed
 * node falls back to a positional label.
 */
export function deriveContextUsageByNode(nodes: UsageNode[]): NodeContextUsage[] {
  const out: NodeContextUsage[] = [];
  (nodes ?? []).forEach((node, i) => {
    const { items } = deriveContextUsage([node]);
    if (items.length > 0) out.push({ node: node.node ?? `agent ${i + 1}`, items });
  });
  return out;
}

/** Deduped ids per kind, counting only successfully-obtained context. */
function rollUp(items: ContextItem[]): Record<ContextKind, string[]> {
  const by: Record<ContextKind, Set<string>> = {
    data: new Set(),
    knowledge: new Set(),
    files: new Set(),
    metrics: new Set(),
    connections: new Set(),
  };
  for (const it of items) {
    if (it.errored) continue;
    by[it.kind].add(it.id);
  }
  return {
    data: [...by.data],
    knowledge: [...by.knowledge],
    files: [...by.files],
    metrics: [...by.metrics],
    connections: [...by.connections],
  };
}
