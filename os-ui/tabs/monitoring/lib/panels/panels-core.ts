/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Monitoring panels' pure parts — payload types, the exact upstream queries, and the
 *             folding of upstream answers into per-system / per-node rows.
 * USER STORY: As a reviewer I want to see the exact PromQL and LogsQL each panel sends, and that an
 *             upstream answer about a system I did not ask for can never reach the payload.
 * ARCHITECTURE:
 *   - Pure (no `server-only`, no I/O) so it runs under `node --test`. The server modules
 *     (agents-panel.ts · data-panel.ts · platform-panel.ts) do the reads.
 *   - Every fold drops rows for ids outside the asked set — a second guard behind the query filter.
 */

/** Whether a source answered. `not_upstream` = the component does not offer this signal. */
export type SourceState = { state: 'live' } | { state: 'unavailable'; reason: string } | { state: 'not_upstream'; reason: string };
export type NotUpstream = { panel: string; reason: string };

export const live: SourceState = { state: 'live' };
export const unavailable = (reason: string): SourceState => ({ state: 'unavailable', reason: reason.slice(0, 300) });

// ------------------------------------------------------------------- agents --

export type PolicyCounts = { denies: number; held: number; allowed: number; byTool: { tool: string; effect: string; n: number }[] };

/** A LogsQL regex literal matching the principals of these systems: `os-<id>` and `os-<id>:<node>`. */
export function systemPrincipalRegex(systemIds: readonly string[]): string {
  const alt = systemIds.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return `^os-(${alt})(:|$)`;
}

function logsqlString(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * OPA's decision log (console → Collector → VictoriaLogs, #217) for the agent-authz decision of these
 * systems' principals, counted by VictoriaLogs per principal, tool and OPA's own `effect`.
 */
export function opaDecisionQuery(systemIds: readonly string[], window = '7d'): string {
  return `_time:${window} msg:"Decision Log" path:"agentic/authz/decision" input.principal:~${logsqlString(systemPrincipalRegex(systemIds))} | stats by (input.principal, input.tool, result.effect) count() as n`;
}

/** `os-<id>` / `os-<id>:<node>` → `<id>` when it is one of the asked systems. */
export function systemOfPrincipal(principal: string, systemIds: ReadonlySet<string>): string | null {
  if (!principal.startsWith('os-')) return null;
  const rest = principal.slice(3);
  const colon = rest.indexOf(':');
  const id = colon === -1 ? rest : rest.slice(0, colon);
  return systemIds.has(id) ? id : null;
}

export function foldDecisions(rows: readonly Record<string, string>[], systemIds: readonly string[]): Map<string, PolicyCounts> {
  const asked = new Set(systemIds);
  const out = new Map<string, PolicyCounts>();
  for (const row of rows) {
    const id = systemOfPrincipal(String(row['input.principal'] ?? ''), asked);
    if (!id) continue;
    const n = Number(row.n) || 0;
    const effect = String(row['result.effect'] ?? 'unknown');
    let c = out.get(id);
    if (!c) out.set(id, (c = { denies: 0, held: 0, allowed: 0, byTool: [] }));
    if (effect === 'deny') c.denies += n;
    else if (effect === 'requires_approval') c.held += n;
    else if (effect === 'allow') c.allowed += n;
    const tool = String(row['input.tool'] ?? '');
    const same = c.byTool.find((t) => t.tool === tool && t.effect === effect);
    if (same) same.n += n;
    else c.byTool.push({ tool, effect, n });
  }
  for (const c of out.values()) c.byTool.sort((a, b) => b.n - a.n);
  return out;
}

/** LiteLLM `/key/list` rows → the spend of each asked system's key (alias `os-<id>`, #98). */
export function keySpendBySystem(keys: readonly { key_alias?: string | null; spend?: number }[], systemIds: readonly string[]): Map<string, number> {
  const asked = new Set(systemIds);
  const out = new Map<string, number>();
  for (const k of keys) {
    const alias = k.key_alias ?? '';
    if (!alias.startsWith('os-')) continue;
    const id = alias.slice(3);
    if (!asked.has(id)) continue;
    out.set(id, (out.get(id) ?? 0) + (Number(k.spend) || 0));
  }
  return out;
}

// ----------------------------------------------------------------- platform --

/** PromQL over the Collector's `kubelet_stats` series (Prometheus naming, VictoriaMetrics). */
export const PROMQL = {
  nodeMemory: 'k8s_node_memory_working_set_bytes / (k8s_node_memory_working_set_bytes + k8s_node_memory_available_bytes)',
  nodeDisk: 'k8s_node_filesystem_usage_bytes / k8s_node_filesystem_capacity_bytes',
  topPodMemory: 'topk(8, k8s_pod_memory_working_set_bytes)',
  topPodCpu: 'topk(8, k8s_pod_cpu_usage)',
} as const;

/** Lines in the last hour that contain the word "error" (any case), counted per namespace and container. */
export const ERROR_LOG_QUERY = '_time:1h i(error) | stats by (k8s.namespace.name, k8s.container.name) count() as errors | sort by (errors desc) | limit 10';

export type Sample = { metric: Record<string, string>; value: number };
export type NodePressure = { node: string; memory: number | null; disk: number | null };
export type PodUse = { pod: string; namespace: string; value: number };

export function nodePressure(mem: readonly Sample[], disk: readonly Sample[]): NodePressure[] {
  const nodes = new Map<string, NodePressure>();
  const at = (n: string) => nodes.get(n) ?? (nodes.set(n, { node: n, memory: null, disk: null }), nodes.get(n)!);
  for (const s of mem) at(s.metric.k8s_node_name ?? '?').memory = s.value;
  for (const s of disk) at(s.metric.k8s_node_name ?? '?').disk = s.value;
  return [...nodes.values()].sort((a, b) => (b.memory ?? 0) - (a.memory ?? 0));
}

export function podUse(samples: readonly Sample[]): PodUse[] {
  return samples.map((s) => ({ pod: s.metric.k8s_pod_name ?? '?', namespace: s.metric.k8s_namespace_name ?? '', value: s.value })).sort((a, b) => b.value - a.value);
}

export type ErrorLogRow = { namespace: string; container: string; errors: number };
export function errorLogRows(rows: readonly Record<string, string>[]): ErrorLogRow[] {
  return rows.map((r) => ({ namespace: r['k8s.namespace.name'] ?? '', container: r['k8s.container.name'] ?? '', errors: Number(r.errors) || 0 }));
}

// --------------------------------------------------------------------- data --

export type TrendPoint = { runId: string; at: string; passed: number; total: number };

/** Check executions of one asset (several checks) → one point per Dagster run: passed / evaluated. */
export function qualityTrend(executions: readonly { runId: string; at: string; passed: boolean | null }[], points = 10): TrendPoint[] {
  const byRun = new Map<string, TrendPoint>();
  for (const e of executions) {
    if (e.passed === null) continue;
    let p = byRun.get(e.runId);
    if (!p) byRun.set(e.runId, (p = { runId: e.runId, at: e.at, passed: 0, total: 0 }));
    p.total += 1;
    if (e.passed) p.passed += 1;
    if (e.at > p.at) p.at = e.at;
  }
  return [...byRun.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-points);
}

/**
 * Downstream assets split by visibility: names only for assets of datasets the viewer can see
 * (`visibleKeys` = their models' keys); every other asset is only COUNTED, in total — no other
 * domain's name (asset or domain) reaches the payload.
 */
export function splitDownstream(keys: readonly string[][], visibleKeys: readonly string[][]): { visible: string[][]; hiddenCount: number } {
  const seen = new Set(visibleKeys.map((k) => k.join('/')));
  const visible: string[][] = [];
  let hiddenCount = 0;
  for (const k of keys) {
    if (seen.has(k.join('/'))) visible.push(k);
    else hiddenCount += 1;
  }
  return { visible, hiddenCount };
}

// ------------------------------------------------------------------- files --

export type FileConversion = 'extracted' | 'pending' | 'failed' | 'not_needed';
export type FileIndexing = 'indexed' | 'empty' | 'failed' | 'stored_only' | 'not_indexed';

export type FileFacts = {
  mode: 'indexed' | 'stored-only';
  extraction: { status: 'extracted' | 'pending' | 'failed' } | null;
  outcome: { status: 'indexed' | 'empty' | 'failed'; chunks?: number } | null;
};

export function conversionOf(f: FileFacts): FileConversion {
  return f.extraction ? f.extraction.status : 'not_needed';
}

export function indexingOf(f: FileFacts): FileIndexing {
  if (f.mode === 'stored-only') return 'stored_only';
  return f.outcome ? f.outcome.status : 'not_indexed';
}

/**
 * Whether OpenSearch agrees with the recorded index outcome. `rows` is what OpenSearch itself counted
 * for the file (null = OpenSearch did not answer, so no verdict). A file recorded as indexed with no row
 * in OpenSearch, or recorded as not indexed with rows there, is a disagreement worth showing.
 */
export function indexAgreement(f: FileFacts, rows: number | null): 'agrees' | 'missing_in_index' | 'unrecorded_rows' | 'unknown' {
  if (rows === null) return 'unknown';
  const idx = indexingOf(f);
  if (idx === 'indexed' && (f.outcome?.chunks ?? 1) > 0 && rows === 0) return 'missing_in_index';
  if ((idx === 'not_indexed' || idx === 'failed' || idx === 'empty') && rows > 0) return 'unrecorded_rows';
  return 'agrees';
}

// --------------------------------------------------------------- knowledge --

export type KnowledgeIndexState = 'indexed' | 'stale' | 'not_indexed' | 'draft_not_indexed';

/**
 * A workflow's index state from OpenSearch's own numbers: `rows` and the newest `ingested_at` it stored.
 * Stale = the workflow changed after the newest ingest. A draft is not indexed until it is published
 * (or indexed on request), so no rows on a draft is not a fault.
 */
export function knowledgeIndexState(w: { status: 'draft' | 'live'; updatedAt: string }, idx: { rows: number; newest: string | null } | undefined): KnowledgeIndexState {
  const rows = idx?.rows ?? 0;
  if (rows === 0) return w.status === 'live' ? 'not_indexed' : 'draft_not_indexed';
  if (idx?.newest && Date.parse(w.updatedAt) > Date.parse(idx.newest)) return 'stale';
  return 'indexed';
}

// -------------------------------------------------------------- data rules --

export type RuleType = 'not_null' | 'unique' | 'range' | 'accepted_values' | 'custom';
export type RuleStatus = 'pass' | 'fail' | 'warn' | 'not_run' | 'unavailable';

/** dbt names a generic test `<test>_<model>_<column>…`; anything not one of ours is a custom test. */
export function ruleTypeOf(checkName: string): RuleType {
  for (const t of ['not_null', 'unique', 'accepted_values', 'range'] as const) if (checkName.startsWith(`${t}_`)) return t;
  return 'custom';
}

/** pass / fail / warn from Dagster's evaluation: a failed check of severity WARN is a warning, not a failure. */
export function ruleStatusOf(ev: { passed: boolean | null; severity: 'WARN' | 'ERROR' | null } | null): RuleStatus {
  if (!ev || ev.passed === null) return 'not_run';
  if (ev.passed) return 'pass';
  return ev.severity === 'WARN' ? 'warn' : 'fail';
}

/**
 * Since when the rule has been failing: the first execution of the unbroken streak (newest first) of
 * failures that ends at the latest run. `exact: false` when the streak reaches the end of what was
 * read (`limit` executions) — it began at or before `since`.
 */
export function failingSince(executions: readonly { at: string; passed: boolean | null }[], limit: number): { since: string | null; exact: boolean } {
  if (executions.length === 0 || executions[0].passed !== false) return { since: null, exact: true };
  let i = 0;
  while (i < executions.length && executions[i].passed === false) i += 1;
  return { since: executions[i - 1].at, exact: !(i === executions.length && executions.length >= limit) };
}

export type RuleTrendPoint = { runId: string; at: string; passed: boolean; failedRows: number | null };

/** Executions (newest first) → points oldest → newest; an execution with no evaluation is skipped. */
export function ruleTrend(executions: readonly { runId: string; at: string; passed: boolean | null; failedRows?: number | null }[], points = 10): RuleTrendPoint[] {
  return executions
    .filter((e): e is typeof e & { passed: boolean } => e.passed !== null)
    .map((e) => ({ runId: e.runId, at: e.at, passed: e.passed, failedRows: e.failedRows ?? null }))
    .reverse()
    .slice(-points);
}
