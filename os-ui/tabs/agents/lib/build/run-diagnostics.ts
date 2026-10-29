/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Pure builders for the Run panel's DIAGNOSTICS table + the downloadable PDF
 * report. Everything here is deterministic and derived from the run's OWN data
 * (per-node cards + tool steps) so the table renders with zero infra. Langfuse
 * token/latency/cost is an OPTIONAL enrichment merged on top when the trace store
 * is reachable — when it is down the rows still stand and we say so honestly.
 *
 * Kept framework-free (no React, no jsPDF) so it is trivially unit-testable: the
 * component maps its run into `DiagRun` and renders `buildDiagnostics`; the PDF
 * button feeds the same shape into `buildRunReport` and paints the report.
 */

/** One tool call in a node's drill-down (the subset diagnostics needs). */
export type DiagStep = { tool: string; isError?: boolean; errorKind?: 'policy' | 'exec' };

/** One agent node of a completed run (the subset diagnostics needs). */
export type DiagNode = {
  node: string;
  model?: string;
  tier?: 'fast' | 'reasoning';
  status: 'ok' | 'denied' | 'error' | 'failed';
  finalText?: string;
  steps: DiagStep[];
};

/** The minimal run shape the diagnostics + report builders consume. */
export type DiagRun = {
  ok: boolean;
  path: string[];
  nodes?: DiagNode[];
  /** Flat governed-call list (single-agent runs). Used for the totals fallback. */
  steps?: { node: string; tool: string; effect: string }[];
  output?: string;
  mode?: 'live' | 'offline-mock';
};

/** A per-node token/latency/cost roll-up read back from Langfuse (optional). */
export type NodeTraceMetric = { node: string; tokens: number; latencyMs: number; costUsd: number };

/** The shaped Langfuse enrichment: honest `available` + per-node + totals. */
export type TraceMetrics = {
  available: boolean;
  perNode: Record<string, NodeTraceMetric>;
  totals: { tokens: number; latencyMs: number; costUsd: number };
};

/** One row of the diagnostics table — one per agent node. */
export type DiagRow = {
  agent: string;
  model?: string;
  tier?: 'fast' | 'reasoning';
  /** governed tool calls this node made */
  calls: number;
  /** denied (policy) + errored (exec) steps in this node */
  denied: number;
  errors: number;
  /** the node's own verdict */
  decision: 'ok' | 'denied' | 'error' | 'failed';
  /** Langfuse enrichment, present only when the trace store was reachable. */
  tokens?: number;
  latencyMs?: number;
  costUsd?: number;
};

export type DiagTotals = {
  nodes: number;
  calls: number;
  denied: number;
  errors: number;
  /** Present only when trace metrics were available. */
  tokens?: number;
  latencyMs?: number;
  costUsd?: number;
};

export type Diagnostics = {
  rows: DiagRow[];
  totals: DiagTotals;
  /** Mirrors the enrichment: false → the UI shows "trace metrics unavailable". */
  traceMetricsAvailable: boolean;
};

/** Count governed calls across the run — per-node steps, else the flat step list. */
export function totalCalls(run: DiagRun): number {
  const nodes = run.nodes ?? [];
  if (nodes.length > 0) return nodes.reduce((s, n) => s + n.steps.length, 0);
  return run.steps?.length ?? 0;
}

/**
 * Build the diagnostics table (one row per agent node) + totals, purely from the
 * run's own data. When `metrics.available` we merge each node's tokens/latency/
 * cost; otherwise the numeric columns are omitted and `traceMetricsAvailable` is
 * false so the table can print an honest note rather than a column of zeros.
 */
export function buildDiagnostics(run: DiagRun, metrics?: TraceMetrics): Diagnostics {
  const nodes = run.nodes ?? [];
  const available = Boolean(metrics?.available);

  const rows: DiagRow[] = nodes.map((n) => {
    const denied = n.steps.filter((s) => s.isError && s.errorKind === 'policy').length;
    const errors = n.steps.filter((s) => s.isError && s.errorKind !== 'policy').length;
    const m = available ? metrics!.perNode[n.node] : undefined;
    return {
      agent: n.node,
      model: n.model,
      tier: n.tier,
      calls: n.steps.length,
      denied,
      errors,
      decision: n.status,
      tokens: m?.tokens,
      latencyMs: m?.latencyMs,
      costUsd: m?.costUsd,
    };
  });

  const totals: DiagTotals = {
    nodes: rows.length,
    calls: totalCalls(run),
    denied: rows.reduce((s, r) => s + r.denied, 0),
    errors: rows.reduce((s, r) => s + r.errors, 0),
  };
  if (available && metrics) {
    totals.tokens = metrics.totals.tokens;
    totals.latencyMs = metrics.totals.latencyMs;
    totals.costUsd = metrics.totals.costUsd;
  }

  return { rows, totals, traceMetricsAvailable: available };
}

/**
 * A raw Langfuse observation (public API). Every field is optional — a version
 * drift or a partial ingest must degrade to zeros, never throw. We read the model
 * usage + latency and attribute it to a node via the trace name / metadata.
 */
export type RawObservation = {
  name?: string;
  startTime?: string;
  endTime?: string;
  latency?: number;
  calculatedTotalCost?: number;
  totalPrice?: number;
  metadata?: { node?: string; principal?: string } | null;
  usage?: { total?: number; totalTokens?: number } | null;
  usageDetails?: { total?: number } | null;
};

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function obsTokens(o: RawObservation): number {
  return num(o.usage?.total ?? o.usage?.totalTokens ?? o.usageDetails?.total);
}

function obsCost(o: RawObservation): number {
  return num(o.calculatedTotalCost ?? o.totalPrice);
}

function obsLatencyMs(o: RawObservation): number {
  if (o.latency != null) return num(o.latency) * 1000; // Langfuse latency is seconds
  if (o.startTime && o.endTime) {
    const ms = new Date(o.endTime).getTime() - new Date(o.startTime).getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  }
  return 0;
}

/**
 * Which node an observation belongs to: explicit metadata.node wins; otherwise
 * match a known node name inside the observation name (traces are named
 * `agent.<tool>` and nodes carry their own names). Returns '' when unknown.
 */
function attributeNode(o: RawObservation, nodeNames: string[]): string {
  const meta = o.metadata?.node;
  if (typeof meta === 'string' && meta) return meta;
  const name = o.name ?? '';
  return nodeNames.find((n) => n && name.includes(n)) ?? '';
}

/**
 * Shape a batch of Langfuse observations into per-node + total token/latency/cost.
 * `available` is TRUE only when the fetch actually returned rows — an empty/failed
 * read yields `available:false` so the caller shows "trace metrics unavailable".
 */
export function shapeTraceMetrics(observations: RawObservation[], nodeNames: string[]): TraceMetrics {
  const empty: TraceMetrics = { available: false, perNode: {}, totals: { tokens: 0, latencyMs: 0, costUsd: 0 } };
  if (!Array.isArray(observations) || observations.length === 0) return empty;

  const perNode: Record<string, NodeTraceMetric> = {};
  const totals = { tokens: 0, latencyMs: 0, costUsd: 0 };
  for (const o of observations) {
    const tokens = obsTokens(o);
    const cost = obsCost(o);
    const latencyMs = obsLatencyMs(o);
    totals.tokens += tokens;
    totals.costUsd += cost;
    totals.latencyMs += latencyMs;
    const node = attributeNode(o, nodeNames);
    if (!node) continue;
    const cur = perNode[node] ?? (perNode[node] = { node, tokens: 0, latencyMs: 0, costUsd: 0 });
    cur.tokens += tokens;
    cur.costUsd += cost;
    cur.latencyMs += latencyMs;
  }
  totals.costUsd = Math.round(totals.costUsd * 1e6) / 1e6;
  return { available: true, perNode, totals };
}

// -------------------------------------------------------------- PDF report ------

/** Identity + timing for the report header (who ran it, when). */
export type ReportMeta = { systemName: string; ranBy: string; at: number; prompt: string };

/** A structured, framework-free report the PDF painter walks section by section. */
export type RunReport = {
  title: string;
  ranBy: string;
  timestamp: string;
  prompt: string;
  summary: string;
  path: string;
  mode: string;
  agents: { name: string; decision: string; model?: string; tier?: string; calls: number; output: string }[];
  table: { head: string[]; rows: string[][]; totals: string[] };
  finalOutput: string;
};

function fmtCost(v?: number): string {
  return v == null ? '—' : `$${v.toFixed(4)}`;
}
function fmtInt(v?: number): string {
  return v == null ? '—' : String(Math.round(v));
}

/** The diagnostics table rendered as string cells for the PDF (and any text view). */
export function diagnosticsTable(diag: Diagnostics): RunReport['table'] {
  const withMetrics = diag.traceMetricsAvailable;
  const head = ['Agent', 'Model / tier', 'Calls', 'Decision', ...(withMetrics ? ['Tokens', 'Latency', 'Cost'] : [])];
  const rows = diag.rows.map((r) => [
    r.agent,
    [r.model, r.tier].filter(Boolean).join(' · ') || '—',
    String(r.calls),
    r.decision + (r.denied ? ` (${r.denied} denied)` : '') + (r.errors ? ` (${r.errors} err)` : ''),
    ...(withMetrics ? [fmtInt(r.tokens), r.latencyMs != null ? `${Math.round(r.latencyMs)}ms` : '—', fmtCost(r.costUsd)] : []),
  ]);
  const totals = [
    'Total',
    `${diag.totals.nodes} agents`,
    String(diag.totals.calls),
    `${diag.totals.denied} denied · ${diag.totals.errors} err`,
    ...(withMetrics
      ? [fmtInt(diag.totals.tokens), diag.totals.latencyMs != null ? `${Math.round(diag.totals.latencyMs)}ms` : '—', fmtCost(diag.totals.costUsd)]
      : []),
  ];
  return { head, rows, totals };
}

/**
 * Map a completed run (+ its diagnostics) into a clean, legible RunReport — the
 * data the PDF is built from. Never touches the DOM: a text/table report so the
 * PDF is selectable and legible, not a screenshot.
 */
export function buildRunReport(run: DiagRun, diag: Diagnostics, meta: ReportMeta): RunReport {
  const agents = (run.nodes ?? []).map((n) => ({
    name: n.node,
    decision: n.status,
    model: n.model,
    tier: n.tier,
    calls: n.steps.length,
    output: (n.finalText ?? '').trim() || '(no output)',
  }));
  return {
    title: meta.systemName || 'Agent run',
    ranBy: meta.ranBy || 'unknown',
    timestamp: new Date(meta.at).toISOString(),
    prompt: meta.prompt?.trim() || '(default task)',
    summary: `${run.ok ? 'Completed' : 'Completed with issues'} · ${diag.totals.calls} governed call${diag.totals.calls === 1 ? '' : 's'} across ${diag.totals.nodes} agent${diag.totals.nodes === 1 ? '' : 's'}`,
    path: run.path.length ? `${run.path.join(' → ')} → END` : '(no path)',
    mode: run.mode ?? 'live',
    agents,
    table: diagnosticsTable(diag),
    finalOutput: (run.output ?? '').trim() || '(the run produced no final text)',
  };
}

/** Filename like `run-<system>-<shortts>.pdf` — filesystem-safe, no spaces. */
export function reportFilename(systemName: string, at: number): string {
  const slug = (systemName || 'run').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'run';
  const ts = new Date(at).toISOString().replace(/[:.]/g, '-').slice(0, 16); // YYYY-MM-DDTHH-MM
  return `run-${slug}-${ts}.pdf`;
}
