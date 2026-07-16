/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Markdown from '@/components/Markdown';
import ProgressStepper, { type Step } from '@/components/core/ProgressStepper';
import {
  buildDiagnostics,
  buildRunReport,
  reportFilename,
  type DiagNode,
  type DiagRun,
  type TraceMetrics,
} from '@/lib/agents/build/run-diagnostics';
import { useUser } from '@/lib/useUser';
import {
  deriveContextUsage,
  deriveContextUsageByNode,
  deepLinkFor,
  type ContextItem,
  type ContextKind,
  type RunContextUsage,
} from '@/lib/agents/build/context-usage';
import type { System } from '@/lib/agents/system-schema';
import { downloadRunPdf } from '@/lib/agents/build/agent-pdf';
import { agentDisplayName } from '@/lib/agents/build/eval-report';

/**
 * Build = execute + verify (Task 4) and Run (Task 7). Build runs the 5 adapters
 * (forgejo / opa / litellm / langgraph / langfuse) apply→verify and shows an
 * inline ✓/✗ row per tool with the exact error — a row is ✓ ONLY when BOTH apply
 * AND verify pass, so Build can never report success without a real check. Run
 * fires a test invocation through the governed gateway (every tool call OPA-checked
 * + Langfuse-traced); any write that needs approval is held in the Governance queue.
 */

type BuildStatus = 'ok' | 'fail' | 'pending';
type BuildRow = { tool: string; applied: boolean; verified: boolean; status: BuildStatus; detail: string; error?: string };
type BuildReport = { ok: boolean; rows: BuildRow[] };
type LastBuild = { ok: boolean; at: number; rows: BuildRow[] };
type ActivityMarker = { kind: 'building' | 'running'; startedAt: number };
type LastRun = {
  at: number;
  running: boolean;
  ok: boolean;
  path: string[];
  traces: number;
  held: number;
  steps: RunStep[];
  /** The persisted per-agent drill-down — so the cards survive a tab-switch/reseed. */
  nodes?: RunNode[];
  /** "Context actually used per run" (#177). Absent on pre-feature runs → re-derived from nodes. */
  contextUsage?: RunContextUsage;
  /** Declared grant ids per kind at run time — for the granted-vs-used strip. */
  grantedIds?: GrantedIds;
  output?: string;
  mode?: 'live' | 'offline-mock';
  traceStoreAvailable?: boolean;
  traceUrl?: string;
};

/** Grant ids per kind, mirroring ContextKind — for the Evaluate granted-vs-used strip. */
type GrantedIds = Record<ContextKind, string[]>;

/** Formats a Unix-ms timestamp as a compact relative time string. */
function timeAgo(atMs: number): string {
  const secs = Math.floor((Date.now() - atMs) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
type RunStep = { node: string; tool: string; effect: string; ran?: boolean };
type NodeStatus = 'ok' | 'failed' | 'denied' | 'error';
/** Why an errored step failed: a real governance block vs an execution failure. */
type ErrorKind = 'policy' | 'exec';
/** One tool call in the drill-down: name, error flag + kind, and (expanded) args → result. */
type NodeStep = { tool: string; isError?: boolean; errorKind?: ErrorKind; summary?: string; args?: string; result?: string };
/** A per-node reveal for the multi-agent run: input given + output + status + tool calls. */
type RunNode = {
  node: string;
  model?: string;
  /** AUTO per-node routing: the resolved tier + the deterministic reason it was chosen. */
  tier?: 'fast' | 'reasoning';
  tierReason?: string;
  status: NodeStatus;
  error?: string;
  input?: string;
  finalText?: string;
  steps: NodeStep[];
};
type RunReport = {
  running: boolean;
  ok: boolean;
  path: string[];
  traces: number;
  held: number;
  steps: RunStep[];
  nodes?: RunNode[];
  contextUsage?: RunContextUsage;
  grantedIds?: GrantedIds;
  output?: string;
  mode?: 'live' | 'offline-mock';
  traceStoreAvailable?: boolean;
  traceUrl?: string;
};

// The run route returns TWO shapes: a single-agent report (output/steps/traces/held)
// and a multi-agent "team" run (finalText/nodes, no steps/traces). Normalize both
// into RunReport so the panel renders either without crashing on a missing field.
type TeamNode = {
  node: string;
  model?: string;
  status?: NodeStatus;
  error?: string;
  input?: string;
  finalText?: string;
  steps?: (NodeStep & { errorKind?: ErrorKind })[];
};
type RawRun = Partial<RunReport> & { team?: boolean; finalText?: string; nodes?: TeamNode[]; contextUsage?: RunContextUsage; grantedIds?: GrantedIds };

function normalizeRun(body: RawRun): RunReport {
  const steps: RunStep[] =
    body.steps ??
    body.nodes?.flatMap((n) =>
      (n.steps ?? []).map((s) => ({
        node: n.node,
        tool: s.tool,
        effect: s.isError ? 'deny' : 'allow',
        ran: true,
      })),
    ) ??
    [];
  // Preserve the per-node drill-down (input / status / finalText / step args→result).
  const nodes: RunNode[] | undefined = body.nodes?.map((n) => ({
    node: n.node,
    model: n.model,
    status: n.status ?? 'ok',
    error: n.error,
    input: n.input,
    finalText: n.finalText,
    steps: (n.steps ?? []).map((s) => ({ tool: s.tool, isError: s.isError, errorKind: s.errorKind, summary: s.summary, args: s.args, result: s.result })),
  }));
  const rawOut = body.output ?? body.finalText;
  // Context actually used: prefer the server-derived record; for runs persisted
  // before #177 shipped, re-derive client-side from the same nodes[].steps[] trace.
  const contextUsage = body.contextUsage ?? (nodes ? deriveContextUsage(nodes) : undefined);
  return {
    running: body.running ?? false,
    ok: body.ok ?? true,
    path: Array.isArray(body.path) ? body.path : [],
    traces: body.traces ?? 0,
    held: body.held ?? 0,
    steps,
    nodes,
    contextUsage,
    grantedIds: body.grantedIds,
    output: typeof rawOut === 'string' ? rawOut : rawOut ? JSON.stringify(rawOut) : undefined,
    mode: body.mode,
    traceStoreAvailable: body.traceStoreAvailable,
    traceUrl: body.traceUrl,
  };
}

const EFFECT_BADGE: Record<string, string> = { allow: 'ok', deny: 'warn', error: 'err', requires_approval: 'warn' };
// 'denied' = a real policy block (warn amber, not alarming red); 'error' = an execution
// failure (neutral, not a governance verdict); 'failed' = the node itself threw.
const NODE_STATUS_BADGE: Record<NodeStatus, string> = { ok: 'ok', denied: 'warn', error: 'err', failed: 'err' };
const NODE_STATUS_LABEL: Record<NodeStatus, string> = { ok: '✓ ok', denied: 'denied', error: 'error', failed: '✗ failed' };

/**
 * The real build phases — the SAME work the server's 5 adapters do (forgejo · opa ·
 * litellm · langgraph · langfuse), in order, described in plain words. The build route
 * is a single call (no per-stage stream), so the stepper advances through these on a
 * gentle timer while the build is in flight, then settles on the real ✓/✗ outcome the
 * moment the report lands. Honest: these are the actual phases, not invented steps.
 */
const BUILD_STAGES: { key: string; label: string; tools: string[] }[] = [
  { key: 'scaffold', label: 'Scaffolding agents…', tools: ['forgejo'] },
  { key: 'grants', label: 'Provisioning tools & grants…', tools: ['opa', 'litellm'] },
  { key: 'graph', label: 'Wiring the graph…', tools: ['langgraph'] },
  { key: 'trace', label: 'Linking traces…', tools: ['langfuse'] },
  { key: 'commit', label: 'Committing agent files…', tools: [] },
];

/**
 * A tasteful, determinate build stepper. While `building`, it walks BUILD_STAGES on a
 * timer (the build is one call, so we pace it); on completion it reflects the REAL
 * outcome — every stage ✓ when the report is green, or the failing stage(s) marked ✗
 * from the report rows. `done` + `ok` come from the landed report.
 */
function BuildProgress({ building, report }: { building: boolean; report: BuildReport | null }) {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    if (!building) return;
    setStage(0);
    const id = setInterval(() => {
      setStage((s) => (s < BUILD_STAGES.length - 1 ? s + 1 : s));
    }, 700);
    return () => clearInterval(id);
  }, [building]);

  const done = !building && !!report;
  // Which stages the report says failed — a stage fails if ANY of its adapter rows failed.
  const failedTools = new Set((report?.rows ?? []).filter((r) => r.status === 'fail').map((r) => r.tool));
  const stageFailed = (tools: string[]) => tools.some((t) => failedTools.has(t));

  // Map the 5 real adapter stages + the terminal Ready row onto the generic stepper's
  // steps. Same states as before: done → teal ✓, fail → red ✗, active → gold spin, else
  // pending. The pct is paced on the build's single-call timer (never 100% until landed).
  const steps: Step[] = BUILD_STAGES.map((st, i) => {
    const failed = done && stageFailed(st.tools);
    const complete = done ? !failed : i < stage;
    const active = building && i === stage;
    return { key: st.key, label: st.label, state: failed ? 'fail' : complete ? 'done' : active ? 'active' : 'pending' };
  });
  steps.push({
    key: 'ready',
    label: done ? (report?.ok ? 'Ready' : 'Build failed — see below') : 'Ready',
    state: done ? (report?.ok ? 'done' : 'fail') : 'pending',
  });

  const pct = done
    ? 100
    : Math.round(((stage + 1) / (BUILD_STAGES.length + 1)) * 100); // never hit 100 until landed

  return <ProgressStepper steps={steps} active={building} done={done} ok={!!report?.ok} pct={pct} />;
}

/**
 * Collapse CONSECUTIVE identical tool rows (same tool + same error-flag/kind) into one
 * summarized line — 34 identical error rows become "query_data ×34 …". Grouping is by
 * (tool, isError, errorKind) so a real result and an error for the same tool stay apart.
 */
type StepGroup = { step: NodeStep; count: number; firstIndex: number };
function groupSteps(steps: NodeStep[]): StepGroup[] {
  const groups: StepGroup[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    const last = groups[groups.length - 1];
    if (last && last.step.tool === s.tool && !!last.step.isError === !!s.isError && last.step.errorKind === s.errorKind) {
      last.count += 1;
    } else {
      groups.push({ step: s, count: 1, firstIndex: i });
    }
  }
  return groups;
}

/** The step badge label: only a real policy block reads "denied"; exec errors read "error". */
function stepBadge(s: NodeStep): { cls: string; label: string } {
  if (!s.isError) return { cls: 'ok', label: 'ok' };
  return s.errorKind === 'policy' ? { cls: 'warn', label: 'denied' } : { cls: 'err', label: 'error' };
}

/** A one-line, human summary of the whole run: did it work, and how far did it get. */
function runSummary(run: RunReport): string {
  const last = run.path[run.path.length - 1];
  const calls = run.steps.length;
  const tail = `${calls} governed call${calls === 1 ? '' : 's'}`;
  const nodes = run.nodes ?? [];
  const failed = nodes.find((n) => n.status === 'failed');
  if (failed) return `Failed at ${failed.node} · ${tail}`;
  const capped = !!run.output && /tool[- ]step budget|tool step limit|step limit \(cap\)/i.test(run.output);
  if (capped) return `Stopped at step cap · ${tail}`;
  return `Completed${last ? ` through ${last} → END` : ''} · ${tail}`;
}

/** Map the panel's RunReport into the pure DiagRun shape the diagnostics/report builders consume. */
function runToDiag(run: RunReport): DiagRun {
  const nodes: DiagNode[] | undefined = run.nodes?.map((n) => ({
    node: n.node,
    model: n.model,
    tier: n.tier,
    status: n.status,
    finalText: n.finalText,
    steps: n.steps.map((s) => ({ tool: s.tool, isError: s.isError, errorKind: s.errorKind })),
  }));
  return {
    ok: run.ok,
    path: run.path,
    nodes,
    steps: run.steps.map((s) => ({ node: s.node, tool: s.tool, effect: s.effect })),
    output: run.output,
    mode: run.mode,
  };
}

/**
 * Live streaming state while a team run is in flight — the current tool step, the
 * agents that have started/finished (to light up the path), and the current node's
 * step count. Cleared to null the moment the terminal result lands.
 */
type LiveStepStatus = 'running' | 'ok' | 'denied' | 'error';
type LiveProgress = {
  /** The node running right now, and its 1-based position over the whole path. */
  node?: string;
  index?: number;
  total?: number;
  /** The current/last tool step of the running node. */
  tool?: string;
  stepStatus?: LiveStepStatus;
  stepIndex?: number;
  /** Nodes that have started (active or done) and nodes that have completed. */
  started: string[];
  completed: string[];
};

// ── Context actually used (#177) ────────────────────────────────────────────
/** Human label + tab route per artifact kind. Files live under /unstructured. The
 *  per-ITEM deep link comes from `deepLinkFor(kind,id)`; this is the tab-level fallback
 *  used for the "kind" group label and when an item has no resolvable item id. */
const KIND_META: Record<ContextKind, { label: string; href: string }> = {
  data: { label: 'Data', href: '/data' },
  files: { label: 'Files', href: '/unstructured' },
  knowledge: { label: 'Knowledge', href: '/knowledge' },
  metrics: { label: 'Metrics', href: '/metrics' },
  connections: { label: 'Connections', href: '/connections' },
};
const KIND_ORDER: ContextKind[] = ['data', 'files', 'knowledge', 'metrics', 'connections'];

/** The read/retrieved/written verb shown on each chip. */
const MODE_LABEL: Record<ContextItem['mode'], string> = { read: 'read', retrieved: 'retrieved', written: 'written' };

/**
 * One artifact chip — a real same-app deep link to the item (its tab, `?focus=<id>`),
 * showing HOW it was used: the mode verb, the tool (`via`), a short arg hint when we
 * have one, and honest markers. Errored calls are muted and read "not obtained" (the
 * context was never actually gained); inferred ids are flagged and, having no resolvable
 * item id, fall back to opening the tab.
 */
function ContextChip({ item }: { item: ContextItem }) {
  const label = item.name ? `${item.name} (${item.id})` : item.id;
  // Prefer the derived per-item deep link; else recompute; else fall back to the tab.
  const href = item.deepLink ?? deepLinkFor(item.kind, item.id) ?? KIND_META[item.kind].href;
  const modeText = item.errored ? 'not obtained' : MODE_LABEL[item.mode];
  const title =
    `${MODE_LABEL[item.mode]} via ${item.via}` +
    (item.hint ? ` — ${item.hint}` : '') +
    (item.errored ? ' — not obtained (call failed)' : '') +
    (item.confidence === 'inferred' ? ' — inferred' : '');
  return (
    <Link
      href={href}
      title={title}
      className="chip"
      style={{
        textDecoration: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        opacity: item.errored ? 0.5 : 1,
      }}
    >
      <span className="mono" style={{ fontSize: 11.5 }}>{label}</span>
      <span className="hint" style={{ fontSize: 10 }}>{modeText}</span>
      <span className="hint mono" style={{ fontSize: 10, opacity: 0.6 }}>{item.via}</span>
      {item.hint ? <span className="hint" style={{ fontSize: 10, opacity: 0.7, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>“{item.hint}”</span> : null}
      {item.confidence === 'inferred' ? <span className="hint" style={{ fontSize: 10, opacity: 0.7 }}>·inferred</span> : null}
    </Link>
  );
}

/** De-dupe items by (kind,id,mode) — one chip per artifact, errored items kept distinct. */
function dedupeItems(items: ContextItem[]): ContextItem[] {
  const seen = new Map<string, ContextItem>();
  for (const it of items) {
    const key = `${it.kind}:${it.id}:${it.mode}:${it.errored ? 'e' : 'o'}`;
    if (!seen.has(key)) seen.set(key, it);
  }
  return [...seen.values()];
}

/**
 * "Context this agent used" — the artifacts a node (or the whole run) actually read,
 * retrieved or wrote, grouped by kind. Honest by design: errored calls are shown muted
 * ("not obtained"), inferred ids are marked. Empty → renders nothing.
 */
function ContextUsed({ items, title }: { items: ContextItem[]; title: string }) {
  const rows = dedupeItems(items);
  if (rows.length === 0) return null;
  const groups = KIND_ORDER.map((k) => ({ kind: k, items: rows.filter((r) => r.kind === k) })).filter((g) => g.items.length > 0);
  return (
    <div>
      <div className="hint" style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {groups.map((g) => (
          <div key={g.kind} style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span className="hint" style={{ fontSize: 11, minWidth: 78 }}>{KIND_META[g.kind].label}</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {g.items.map((it, i) => <ContextChip key={`${it.id}-${it.mode}-${i}`} item={it} />)}
            </div>
          </div>
        ))}
      </div>
      <p className="hint" style={{ fontSize: 10.5, marginTop: 6, opacity: 0.75 }}>
        Agents discover context at runtime — this is the real consumption. Truncated tool results may under-count.
      </p>
    </div>
  );
}

/** Context items scoped to ONE node — re-derived from that node's own tool steps. */
function nodeContextItems(node: RunNode): ContextItem[] {
  return deriveContextUsage([{ steps: node.steps }]).items;
}

/**
 * Run-level roll-up at the top of Evaluate: a count-per-kind summary line + the full
 * deduped chip list of everything the whole run touched. Empty → renders nothing.
 */
function ContextRollup({ run }: { run: RunReport }) {
  const usage = run.contextUsage;
  const items = usage?.items ?? [];
  if (items.length === 0) return null;
  const counts = KIND_ORDER
    .map((k) => ({ k, n: usage?.byKind[k].length ?? 0 }))
    .filter((c) => c.n > 0);
  return (
    <div style={{ marginBottom: 14, padding: '10px 12px', border: '1px solid var(--border, #e5e5e5)', borderRadius: 10 }}>
      <div className="section-title" style={{ marginTop: 0 }}>Context actually used</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {counts.map((c) => (
          <span key={c.k} className="badge">{KIND_META[c.k].label}: {c.n}</span>
        ))}
      </div>
      <ContextUsed items={items} title="Everything this run touched" />
    </div>
  );
}

/**
 * The Evaluate "Grants vs. usage" strip: for each granted artifact, is it USED (green)
 * or a granted-but-unused "dead grant" (muted). Reads grants + used ids off the run —
 * never edits the grant editor. Renders nothing when no grants were recorded.
 */
function GrantsVsUsage({ granted, usage }: { granted: GrantedIds; usage?: RunContextUsage }) {
  const usedByKind = usage?.byKind;
  const rows = KIND_ORDER.map((kind) => {
    const ids = granted[kind] ?? [];
    if (ids.length === 0) return null;
    const used = new Set(usedByKind?.[kind] ?? []);
    return { kind, ids, used };
  }).filter((r): r is { kind: ContextKind; ids: string[]; used: Set<string> } => r !== null);
  if (rows.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="section-title" style={{ marginTop: 0 }}>Grants vs. usage</div>
      <p className="hint" style={{ marginTop: 0 }}>
        What the team was granted, and what this run actually touched. A muted grant is a “dead grant” — held but unused.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((r) => (
          <div key={r.kind} style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span className="hint" style={{ fontSize: 11, minWidth: 78 }}>{KIND_META[r.kind].label}</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {r.ids.map((id) => {
                const isUsed = r.used.has(id);
                const href = deepLinkFor(r.kind, id) ?? KIND_META[r.kind].href;
                return (
                  <Link
                    key={id}
                    href={href}
                    className={isUsed ? 'chip ok' : 'chip'}
                    title={isUsed ? 'granted and used this run' : 'granted but unused this run (dead grant)'}
                    style={{ textDecoration: 'none', opacity: isUsed ? 1 : 0.55 }}
                  >
                    <span className="mono" style={{ fontSize: 11.5 }}>{id}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A calm one-line "what is happening right now" for the live banner. */
function liveLine(p: LiveProgress): string {
  if (!p.node) return 'Starting the team…';
  const where = p.index && p.total ? ` (agent ${p.index} of ${p.total})` : '';
  if (!p.tool) return `${p.node} — thinking${where}`;
  const verb = p.stepStatus === 'running' ? 'running' : p.stepStatus ?? 'done';
  const step = p.stepIndex ? ` · step ${p.stepIndex}` : '';
  return `${p.node} · ${p.tool} — ${verb}${step}${where}`;
}

/**
 * Build the generic ProgressStepper steps for an in-flight team run: one step per agent
 * in the node path, driven off the live stream. A node in `completed` → done; the current
 * node (or a started-but-not-completed node) → active; a policy-block/execution error on
 * the CURRENT node's step → fail; not yet started → pending. `labelOf` gives each step its
 * display (short) name. Empty when the path is unknown (single-shot runs fall back to the line).
 */
function runSteps(nodePath: string[], live: LiveProgress | null, labelOf: (id: string) => string): Step[] {
  const completed = new Set(live?.completed ?? []);
  const started = new Set(live?.started ?? []);
  const failedNow = live?.node && (live.stepStatus === 'error' || live.stepStatus === 'denied') ? live.node : undefined;
  return nodePath.map((n, i) => {
    let state: Step['state'] = 'pending';
    if (completed.has(n)) state = 'done';
    else if (n === failedNow) state = 'fail';
    else if (n === live?.node || (started.has(n) && !completed.has(n))) state = 'active';
    return { key: `${n}-${i}`, label: labelOf(n), state };
  });
}

/**
 * The per-agent, step-by-step reveal for a multi-agent run — each agent as a card with
 * its status, input, output and (grouped) tool calls. Extracted so it can render in BOTH
 * Developer mode's combined Run view AND Simple mode's Evaluate phase (understanding the
 * run IS evaluating it) from ONE source, with no behavioural change.
 */
function TeamStepByStep({
  run, openNodes, openSteps, toggleNode, toggleStep, labelOf,
}: {
  run: RunReport;
  openNodes: Record<string, boolean>;
  openSteps: Record<string, boolean>;
  toggleNode: (k: string) => void;
  toggleStep: (k: string) => void;
  /** Map an agent id to its display (short) name — falls back to the id. */
  labelOf: (id: string) => string;
}) {
  if (!run.nodes || run.nodes.length === 0) return null;
  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>The team, step by step</div>
      <p className="hint" style={{ marginTop: 0 }}>Click an agent to see what it was given, what it produced, and each tool call.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
        {run.nodes.map((n, i) => {
          const nk = `${n.node}-${i}`;
          const open = !!openNodes[nk];
          return (
            <div key={nk} className="node-card" style={{ border: '1px solid var(--border, #e5e5e5)', borderRadius: 10, padding: '10px 12px' }}>
              {/* Collapsed header — a clean summary; click to drill in. */}
              <button
                type="button"
                onClick={() => toggleNode(nk)}
                aria-expanded={open}
                style={{ all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}
              >
                <span style={{ opacity: 0.5, width: 12, display: 'inline-block' }}>{open ? '▾' : '▸'}</span>
                <span className="mono" style={{ fontWeight: 600 }}>{labelOf(n.node)}</span>
                <span className={`badge ${NODE_STATUS_BADGE[n.status]}`}>{NODE_STATUS_LABEL[n.status]}</span>
                {n.steps.length > 0 ? <span className="hint" style={{ fontSize: 11 }}>{n.steps.length} tool call{n.steps.length === 1 ? '' : 's'}</span> : null}
                {n.tier ? <span className="badge muted" style={{ marginLeft: 'auto', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.3 }}>{n.tier}</span> : null}
                {n.model ? <span className="hint mono" style={{ marginLeft: n.tier ? 0 : 'auto', fontSize: 11, opacity: 0.7 }}>{n.model}</span> : null}
              </button>
              {n.error ? <div className="b-off" style={{ marginTop: 6 }}>{n.error}</div> : null}

              {open ? (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {/* AUTO model routing — why this agent got its tier (zero-cost, deterministic). */}
                  {n.tierReason ? (
                    <div className="hint" style={{ fontSize: 11.5 }}>
                      Model: <strong>{n.tier}</strong> — {n.tierReason}
                    </div>
                  ) : null}
                  {/* INPUT — what this agent was given. */}
                  {n.input ? (
                    <div>
                      <div className="hint" style={{ fontWeight: 600, marginBottom: 2 }}>Input — what this agent was given</div>
                      <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11.5, maxHeight: 200, overflow: 'auto', background: 'var(--surface-2, #f6f6f6)', borderRadius: 8, padding: '8px 10px' }}>{n.input}</pre>
                    </div>
                  ) : null}
                  {/* OUTPUT — what it produced. */}
                  {n.finalText ? (
                    <div>
                      <div className="hint" style={{ fontWeight: 600, marginBottom: 2 }}>Output</div>
                      <p style={{ margin: 0, whiteSpace: 'pre-wrap', opacity: 0.92 }}>{n.finalText}</p>
                    </div>
                  ) : null}
                  {/* Tool calls — CONSECUTIVE identical rows collapsed to one
                      "tool ×N" line so a 34× error loop reads as a single row. */}
                  {n.steps.length > 0 ? (
                    <div>
                      <div className="hint" style={{ fontWeight: 600, marginBottom: 4 }}>Tool calls</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {groupSteps(n.steps).map((g) => {
                          const s = g.step;
                          const j = g.firstIndex;
                          const sk = `${nk}-${s.tool}-${j}`;
                          const sOpen = !!openSteps[sk];
                          const inspectable = !!(s.args || s.result);
                          const badge = stepBadge(s);
                          return (
                            <div key={sk} style={{ fontSize: 12.5 }}>
                              <button
                                type="button"
                                onClick={() => inspectable && toggleStep(sk)}
                                aria-expanded={sOpen}
                                style={{ all: 'unset', cursor: inspectable ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}
                              >
                                {inspectable ? <span style={{ opacity: 0.5, width: 10, display: 'inline-block' }}>{sOpen ? '▾' : '▸'}</span> : <span style={{ width: 10, display: 'inline-block' }} />}
                                <span className={`badge ${badge.cls}`}>{badge.label}</span>
                                <span className="mono">{s.tool}</span>
                                {g.count > 1 ? <span className="mono" style={{ opacity: 0.6 }}>×{g.count}</span> : null}
                                {!sOpen && s.summary ? <span style={{ opacity: 0.7 }}> — {s.summary}</span> : null}
                              </button>
                              {sOpen ? (
                                <div style={{ margin: '4px 0 6px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                                  {s.args ? (
                                    <div>
                                      <div className="hint" style={{ fontSize: 11 }}>args (input)</div>
                                      <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11.5, maxHeight: 160, overflow: 'auto', background: 'var(--surface-2, #f6f6f6)', borderRadius: 8, padding: '6px 8px' }}>{s.args}</pre>
                                    </div>
                                  ) : null}
                                  {s.result ? (
                                    <div>
                                      <div className="hint" style={{ fontSize: 11 }}>result (output)</div>
                                      <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11.5, maxHeight: 200, overflow: 'auto', background: 'var(--surface-2, #f6f6f6)', borderRadius: 8, padding: '6px 8px' }}>{s.result}</pre>
                                    </div>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                  {/* Context this agent actually used — derived from ITS OWN tool steps. */}
                  <ContextUsed items={nodeContextItems(n)} title="Context this agent used" />
                </div>
              ) : (
                // Collapsed: keep a one-line taste of the output so the card still reads.
                n.finalText ? <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', opacity: 0.75, fontSize: 12.5, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{n.finalText}</p> : null
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

export default function BuildRunPanel({
  systemId,
  system,
  running,
  canEdit,
  lastBuild,
  activity,
  lastRun,
  nodePath,
  onStateChange,
  phase = 'all',
}: {
  systemId: string;
  /** The full System — for display (short) names, the graph, and the Evaluate PDF.
   *  Optional so Developer mode (which doesn't pass it) is unchanged. */
  system?: System;
  running: boolean;
  canEdit: boolean;
  lastBuild?: LastBuild | null;
  activity?: ActivityMarker | null;
  lastRun?: LastRun | null;
  /** The team's node path — shown as an immediate in-progress affordance on Run. */
  nodePath?: string[];
  onStateChange: () => void;
  /**
   * Which sections to render. Simple mode's 5-phase flow reuses this ONE panel but
   * shows only the section for the current phase: `'build'` = compile+verify only,
   * `'run'` = the run trigger + results (final output, per-node drill-down, live
   * progress), `'evaluate'` = the assessment (diagnostics table, Langfuse link, PDF).
   * Developer mode passes nothing → `'all'`, so it is unchanged.
   */
  phase?: 'all' | 'build' | 'run' | 'evaluate';
}) {
  const showBuild = phase === 'all' || phase === 'build';
  const showRun = phase === 'all' || phase === 'run';
  const showEvaluate = phase === 'all' || phase === 'evaluate';
  const [building, setBuilding] = useState(false);
  // Seed from server-persisted lastBuild so the panel survives tab-switches.
  const [report, setReport] = useState<BuildReport | null>(lastBuild ?? null);
  // Track the timestamp of the currently displayed report (null = never built).
  const [builtAt, setBuiltAt] = useState<number | null>(lastBuild?.at ?? null);
  const [buildErr, setBuildErr] = useState('');

  const [prompt, setPrompt] = useState('');
  // Whether the optional "add input for this run" field is revealed. Default hidden:
  // the primary affordance is a one-click ▶ Run of the task defined in Define.
  const [showInput, setShowInput] = useState(false);
  const [runningNow, setRunningNow] = useState(false);
  // Seed from server-persisted lastRun so the panel survives tab-switches.
  const [run, setRun] = useState<RunReport | null>(lastRun ?? null);
  const [runErr, setRunErr] = useState('');
  // LIVE progress (streaming): the current step line + which agents have started/finished.
  const [live, setLive] = useState<LiveProgress | null>(null);
  // Which agent cards are expanded (drill-down), and which individual tool steps.
  const [openNodes, setOpenNodes] = useState<Record<string, boolean>>({});
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({});
  const toggleNode = (k: string) => setOpenNodes((m) => ({ ...m, [k]: !m[k] }));
  const toggleStep = (k: string) => setOpenSteps((m) => ({ ...m, [k]: !m[k] }));
  // The signed-in user — for the "who ran it" line in the PDF report.
  const { user } = useUser();
  // Optional Langfuse enrichment for the diagnostics table (tokens/latency/cost).
  // The table always renders from the run's own steps; this only decorates it when
  // the trace store is reachable. Fetched once per completed run.
  const [metrics, setMetrics] = useState<TraceMetrics | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  const runComplete = !!run && !runningNow && ((run.nodes && run.nodes.length > 0) || !!run.output);

  /** Agent id → display (short) name, from the System. Falls back to the id. */
  const labelOf = (id: string): string => {
    const a = system?.agents.find((x) => x.id === id);
    return a ? agentDisplayName(a) : id;
  };

  // Fetch Langfuse trace metrics when a run completes. Degrades silently: any
  // failure just leaves `metrics` null and the table shows its honest note.
  useEffect(() => {
    if (!runComplete || !run) { setMetrics(null); return; }
    let cancelled = false;
    const nodes = (run.nodes ?? []).map((n) => n.node).join(',');
    fetch(`/api/agents/systems/${systemId}/run/diagnostics?nodes=${encodeURIComponent(nodes)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { metrics?: TraceMetrics } | null) => { if (!cancelled) setMetrics(b?.metrics ?? null); })
      .catch(() => { if (!cancelled) setMetrics(null); });
    return () => { cancelled = true; };
    // Re-fetch per distinct run (path is a cheap identity for a completed run).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runComplete, systemId, run?.path.join('>')]);

  /**
   * RUN-phase PDF — EXACTLY the Run screen (final output + per-agent results + status),
   * nothing else. Uses the shared painter so it matches the Evaluate report's look.
   */
  const downloadRunResultsPdf = async () => {
    if (!run || !system) return;
    setPdfBusy(true);
    try {
      await downloadRunPdf(system, runToDiag(run), {
        ranBy: user?.name ?? 'unknown',
        at: lastRun?.at ?? Date.now(),
        prompt,
      });
    } catch (e) {
      setRunErr(`Could not generate the PDF report: ${(e as Error).message}`);
    } finally {
      setPdfBusy(false);
    }
  };

  /** Build + download a clean, legible PDF of the current run (client-side, offline-safe). */
  const downloadPdf = async () => {
    if (!run) return;
    setPdfBusy(true);
    try {
      const [{ jsPDF }, autoTableMod] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
      const autoTable = autoTableMod.default;
      const diag = buildDiagnostics(runToDiag(run), metrics ?? undefined);
      const at = lastRun?.at ?? Date.now();
      const report = buildRunReport(runToDiag(run), diag, {
        systemName: systemId,
        ranBy: user?.name ?? 'unknown',
        at,
        prompt,
      });

      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      const M = 40;
      const W = doc.internal.pageSize.getWidth();
      let y = M;
      const line = (text: string, size = 10, bold = false, gap = 14) => {
        doc.setFont('helvetica', bold ? 'bold' : 'normal');
        doc.setFontSize(size);
        for (const l of doc.splitTextToSize(text, W - M * 2)) {
          if (y > doc.internal.pageSize.getHeight() - M) { doc.addPage(); y = M; }
          doc.text(l, M, y);
          y += gap;
        }
      };
      const space = (h = 8) => { y += h; };
      const afterTableY = () => ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y);

      // Strip inline markdown so text reads cleanly in the PDF (no **, `, leading #).
      const cleanInline = (s: string) =>
        s.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').replace(/`(.*?)`/g, '$1').replace(/^#+\s*/, '').trimEnd();
      const splitRow = (s: string) => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => cleanInline(c.trim()));
      const isTableSep = (s: string) => /-{2,}/.test(s) && /^[\s:|-]+$/.test(s.trim());

      // Render a markdown string: GFM tables become real tables (autoTable),
      // headings/bullets/paragraphs become formatted text. This is what makes the
      // agent outputs + final output render as tables instead of raw "| a | b |".
      const renderMarkdown = (md: string | undefined, size = 10) => {
        const lines = (md ?? '').replace(/\r/g, '').split('\n');
        let i = 0;
        while (i < lines.length) {
          const ln = lines[i];
          if (ln.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
            const head = splitRow(ln);
            const rows: string[][] = [];
            i += 2;
            while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
              rows.push(splitRow(lines[i]));
              i += 1;
            }
            if (y > doc.internal.pageSize.getHeight() - M - 40) { doc.addPage(); y = M; }
            autoTable(doc, {
              startY: y,
              head: [head],
              body: rows,
              margin: { left: M, right: M },
              styles: { fontSize: 8, cellPadding: 3, overflow: 'linebreak' },
              headStyles: { fillColor: [30, 30, 30] },
            });
            y = afterTableY() + 12;
            continue;
          }
          const h = ln.match(/^(#{1,6})\s+(.*)$/);
          if (h) { space(2); line(cleanInline(h[2]), size + 1, true, 15); i += 1; continue; }
          if (ln.trim() === '') { space(4); i += 1; continue; }
          const b = ln.match(/^\s*[-*+]\s+(.*)$/);
          if (b) { line(`•  ${cleanInline(b[1])}`, size); i += 1; continue; }
          line(cleanInline(ln), size);
          i += 1;
        }
      };

      line(report.title, 16, true, 20);
      line(`Run report · ${report.summary}`, 10);
      line(`Ran by ${report.ranBy} · ${report.timestamp} · mode: ${report.mode}`, 9);
      space();
      line('Task', 11, true);
      line(report.prompt, 10);
      space();
      line('Path', 11, true);
      line(report.path, 10);
      space();

      // ── Section 1: Run results ──────────────────────────────────────────────
      line('Run results', 12, true, 16);
      line('Final output', 11, true);
      renderMarkdown(report.finalOutput, 10);

      if (report.agents.length > 0) {
        space(4);
        line('Per-agent outputs', 11, true);
        for (const a of report.agents) {
          space(4);
          line(`${a.name} — ${a.decision}${a.model ? ` · ${a.model}` : ''}${a.tier ? ` · ${a.tier}` : ''} · ${a.calls} call${a.calls === 1 ? '' : 's'}`, 10, true);
          renderMarkdown(a.output.length > 2000 ? `${a.output.slice(0, 2000)}…` : a.output, 9);
        }
      } else {
        space(4);
        line('No run yet — run the team to see output here.', 9);
      }

      // ── Section 2: Evaluate / Assessment ───────────────────────────────────
      space(8);
      line('Assessment', 12, true, 16);
      line('Diagnostics', 11, true);
      if (!diag.traceMetricsAvailable) line('Trace metrics unavailable — showing governed-call counts from the run.', 8);
      autoTable(doc, {
        startY: y,
        head: [report.table.head],
        body: report.table.rows,
        foot: [report.table.totals],
        margin: { left: M, right: M },
        styles: { fontSize: 8, cellPadding: 4 },
        headStyles: { fillColor: [30, 30, 30] },
        footStyles: { fillColor: [240, 240, 240], textColor: 20, fontStyle: 'bold' },
      });
      y = ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y) + 20;

      doc.save(reportFilename(systemId, at));
    } catch (e) {
      setRunErr(`Could not generate the PDF report: ${(e as Error).message}`);
    } finally {
      setPdfBusy(false);
    }
  };

  const doBuild = async () => {
    setBuilding(true);
    setBuildErr('');
    try {
      const res = await fetch(`/api/agents/systems/${systemId}/build`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) setBuildErr(body.error ?? 'Build failed');
      else { setReport(body as BuildReport); setBuiltAt(Date.now()); }
    } catch (e) {
      setBuildErr((e as Error).message);
    } finally {
      setBuilding(false);
    }
  };

  /** Fold one streamed progress event into the live banner state. */
  const applyEvent = (event: string, data: Record<string, unknown>) => {
    if (event === 'node-started') {
      const node = String(data.node ?? '');
      setLive((p) => ({
        ...(p ?? { started: [], completed: [] }),
        node,
        index: typeof data.index === 'number' ? data.index : undefined,
        total: typeof data.total === 'number' ? data.total : undefined,
        tool: undefined,
        stepStatus: undefined,
        stepIndex: undefined,
        started: p?.started.includes(node) ? p.started : [...(p?.started ?? []), node],
      }));
    } else if (event === 'tool-step') {
      setLive((p) => ({
        ...(p ?? { started: [], completed: [] }),
        node: String(data.node ?? p?.node ?? ''),
        tool: String(data.tool ?? ''),
        stepStatus: (data.status as LiveStepStatus) ?? 'running',
        stepIndex: typeof data.index === 'number' ? data.index : undefined,
      }));
    } else if (event === 'node-completed') {
      const node = String(data.node ?? '');
      setLive((p) => ({
        ...(p ?? { started: [], completed: [] }),
        completed: p?.completed.includes(node) ? p.completed : [...(p?.completed ?? []), node],
      }));
    }
  };

  const doRun = async (stop = false) => {
    setRunningNow(true);
    setRunErr('');
    // Immediately clear the prior result so the in-progress state is unambiguous —
    // the student sees "running the team…" the instant they press Run, never a stale
    // report or a silent spinner. (A stop press keeps the last result visible.)
    if (!stop) { setRun(null); setLive(null); }
    try {
      const res = await fetch(`/api/agents/systems/${systemId}/run`, {
        method: 'POST',
        // Ask for live SSE progress on a run (not on a stop). The server keeps a
        // non-streaming JSON fallback for callers that don't request the stream.
        headers: { 'content-type': 'application/json', ...(stop ? {} : { accept: 'text/event-stream' }) },
        // Send the typed task; an empty prompt lets the server fill a real, purpose-derived
        // default task (NOT "Test invocation"), so the run does the team's actual job.
        body: JSON.stringify(stop ? { stop: true } : prompt.trim() ? { prompt: prompt.trim() } : {}),
      });

      const isStream = (res.headers.get('content-type') ?? '').includes('text/event-stream');
      if (!stop && isStream && res.body) {
        // Parse the SSE stream frame-by-frame: light up agents as they run and show
        // the current step live; `done` carries the SAME full result the non-stream
        // path returns, so the completed view is byte-for-byte unchanged.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let settled = false;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split('\n\n');
          buf = frames.pop() ?? '';
          for (const frame of frames) {
            const evLine = frame.split('\n').find((l) => l.startsWith('event:'));
            const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
            if (!evLine || !dataLine) continue;
            const event = evLine.slice(6).trim();
            let data: Record<string, unknown> = {};
            try { data = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
            if (event === 'done') {
              settled = true;
              setRun(normalizeRun(data as RawRun));
              setLive(null);
            } else if (event === 'error') {
              settled = true;
              setRunErr(String(data.error ?? 'Run failed'));
            } else {
              applyEvent(event, data);
            }
          }
        }
        // Stream ended without a terminal frame (disconnect): never leave a stuck
        // spinner — surface an honest message so the student can retry.
        if (!settled) setRunErr('The run stream ended before a result arrived — please run again.');
      } else {
        // Non-streaming (stop press, or a server without the stream): read JSON.
        const body = await res.json();
        if (!res.ok) setRunErr(body.error ?? 'Run failed');
        else if (!stop) setRun(normalizeRun(body as RawRun));
      }
      onStateChange();
    } catch (e) {
      setRunErr((e as Error).message);
    } finally {
      setRunningNow(false);
      setLive(null);
    }
  };

  return (
    <div className="buildrun-panel">
      {showBuild ? (
      <>
      <div className="section-title" style={{ marginTop: 4 }}>
        {phase === 'build' ? 'Build' : 'Build — execute + verify'}
        <button className="btn lg" style={{ marginLeft: 'auto' }} onClick={doBuild} disabled={building || !canEdit}>
          {building ? <span className="spin" /> : builtAt ? 'Rebuild' : 'Build'}
        </button>
      </div>
      {/* Live build progress + commentary — the real 5-adapter phases as a determinate
          stepper. Shown while building, and holds the final ✓/✗ state after it lands. */}
      {building || (builtAt !== null && report) ? (
        <BuildProgress building={building} report={report} />
      ) : null}
      {/* In-progress marker: shown to a returning user while the build is still running. */}
      {activity?.kind === 'building' && !building ? (
        <div className="hint" style={{ marginTop: 2, marginBottom: 4, color: 'var(--warn, #b7791f)' }}>
          <span className="spin" style={{ marginRight: 6 }} />
          Building since {timeAgo(activity.startedAt)} — in progress on another tab or session
        </div>
      ) : null}
      {builtAt ? (
        <div className="hint" style={{ marginTop: 2, marginBottom: 4 }}>
          Last built {timeAgo(builtAt)}
          {report ? (
            <>
              {' · '}
              <span className={`badge ${report.ok ? 'ok' : 'err'}`} style={{ fontSize: 11 }}>
                {report.ok
                  ? '✓ all green'
                  : `✗ ${report.rows.filter((r) => r.status === 'fail').length} failing`}
              </span>
            </>
          ) : null}
        </div>
      ) : null}
      <p className="hint" style={{ marginTop: 0 }}>
        Compiles system.yaml → LangGraph, writes the Forgejo files, registers the LiteLLM key +
        routing and the OPA grants, links Langfuse — then verifies each with a probe. Mocked in kind.
      </p>
      {buildErr ? <div className="error">{buildErr}</div> : null}
      {report ? (
        <div className="table-wrap" style={{ marginTop: 4 }}>
          <table>
            <thead><tr><th>Tool</th><th>Status</th><th>Detail</th></tr></thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.tool}>
                  <td className="mono">{r.tool}</td>
                  <td>
                    {r.status === 'pending' ? (
                      <span className="badge" style={{ opacity: 0.7 }}>• needs a run first</span>
                    ) : (
                      <span className={`badge ${r.status === 'ok' ? 'ok' : 'err'}`}>{r.status === 'ok' ? '✓ ok' : '✗ fail'}</span>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'normal', fontSize: 12.5 }}>
                    {r.status === 'fail' ? <span className="b-off">{r.error ?? r.detail}</span> : r.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: '8px 12px' }}>
            <span className={`badge ${report.ok ? 'ok' : 'err'}`}>{report.ok ? '✓ Build verified' : '✗ Build failed verification'}</span>
          </div>
        </div>
      ) : null}
      </>
      ) : null}

      {showRun ? (
      <>
      <div className="section-title">
        Run
        {/* Developer mode ('all') keeps the combined run+assessment PDF. Simple mode's
            Run phase gets a Run-ONLY "Results Report" — exactly what's on screen. */}
        {phase === 'all' ? (
          <button
            className="btn ghost"
            style={{ marginLeft: 'auto' }}
            onClick={downloadPdf}
            disabled={!runComplete || pdfBusy}
            title={runComplete ? 'Download a PDF report of this run' : 'Run the team first'}
          >
            {pdfBusy ? <span className="spin" /> : 'Download PDF report'}
          </button>
        ) : phase === 'run' ? (
          <button
            className="btn ghost"
            style={{ marginLeft: 'auto' }}
            onClick={downloadRunResultsPdf}
            disabled={!runComplete || pdfBusy || !system}
            title={runComplete ? 'Download a PDF of the run results shown here' : 'Run the team first'}
          >
            {pdfBusy ? <span className="spin" /> : 'Download PDF Results Report'}
          </button>
        ) : null}
      </div>
      {/* In-progress marker: shown to a returning user while the run is still going. */}
      {activity?.kind === 'running' && !runningNow ? (
        <div className="hint" style={{ marginTop: 2, marginBottom: 4, color: 'var(--warn, #b7791f)' }}>
          <span className="spin" style={{ marginRight: 6 }} />
          Running since {timeAgo(activity.startedAt)} — in progress on another tab or session
        </div>
      ) : null}
      {/* Seed timestamp for the persisted run result. */}
      {run && lastRun && !runningNow ? (
        <div className="hint" style={{ marginTop: 2, marginBottom: 4 }}>
          Last run {timeAgo(lastRun.at)}
        </div>
      ) : null}
      <p className="hint" style={{ marginTop: 0 }}>
        The team walks the graph from the entrypoint; every tool call is forced through the
        governed gateway (LiteLLM → OPA → Langfuse). Approvals land in Governance.
      </p>
      {/* Primary affordance: one click runs the task DEFINED in Define. The server
          fills a real, purpose-derived default when the prompt is empty — no need to
          re-type the task. An optional collapsible adds a one-off input for this run. */}
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn lg" onClick={() => doRun(false)} disabled={runningNow || !canEdit}>
          {runningNow ? <span className="spin" /> : '▶ Run'}
        </button>
        {running ? (
          <button className="btn ghost sm" onClick={() => doRun(true)} disabled={runningNow || !canEdit}>Stop</button>
        ) : null}
        {!showInput ? (
          <button className="btn ghost sm" onClick={() => setShowInput(true)} disabled={runningNow}>
            Add input for this run (optional)
          </button>
        ) : null}
      </div>
      {showInput ? (
        <div style={{ marginTop: 8 }}>
          <label className="hint" style={{ fontWeight: 600, display: 'block', marginBottom: 4 }} htmlFor="run-task">
            Add input for this run (optional) — leave empty to run the defined task
          </label>
          <input
            id="run-task"
            type="text"
            value={prompt}
            autoFocus
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') doRun(false); }}
            placeholder="e.g. Review last month's campaigns and recommend budget moves"
            style={{ width: '100%' }}
          />
        </div>
      ) : null}
      {runErr ? <div className="error" style={{ marginTop: 10 }}>{runErr}</div> : null}

      {/* LIVE in-progress — the SAME fancy determinate stepper the Build phase shows,
          now for a team run: one step per agent in the path, driven off the live stream
          (done ✓ / active gold-spin / fail ✗ / pending), with liveLine() as the commentary
          ("performance_analyst · query_data — running · step 5"). Replaced by the per-node
          reveal the moment the terminal result lands. A single-shot run with no known path
          falls back to the calm one-line indicator. */}
      {runningNow && !run ? (
        <div className="answer running-now" style={{ marginTop: 12, fontSize: 13 }} aria-live="polite">
          {nodePath && nodePath.length > 0 ? (
            <>
              <ProgressStepper
                steps={runSteps(nodePath, live, labelOf)}
                active
                commentary={live ? liveLine(live) : 'Running the team…'}
              />
              <p className="hint" style={{ marginTop: 6 }}>Each agent runs in turn, handing its results to the next. This may take a moment.</p>
            </>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="spin" />
              <strong>{live ? liveLine(live) : 'Running the team…'}</strong>
            </div>
          )}
        </div>
      ) : null}
      </>
      ) : null}

      {run ? (
        <div className="answer" style={{ marginTop: 12, fontSize: 13 }}>
          {showRun ? (
          <>
          {/* One-line run summary — a student sees instantly whether it worked and how far
              it got, before any drill-down. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span className={`badge ${run.ok ? 'ok' : 'warn'}`}>{run.ok ? '✓' : '!'}</span>
            <strong style={{ fontSize: 13 }}>{runSummary(run)}</strong>
          </div>
          {/* FIX 2 — node-by-node reveal (multi-agent runs): each agent as a card with
              its status, what it concluded, and the tool calls it made (with a short
              result summary + denial/error flags). One scroll, Apple-clean.
              In Simple mode this per-agent breakdown lives under EVALUATE (understanding
              the run IS evaluating it) — see the mirrored block below; here it renders
              only in Developer mode's combined view. */}
          {phase === 'all' ? (
            <TeamStepByStep run={run} openNodes={openNodes} openSteps={openSteps} toggleNode={toggleNode} toggleStep={toggleStep} labelOf={labelOf} />
          ) : null}

          {/* Final output — always shown, straight from the run (no Langfuse needed).
              For a team run this is THE result the student wants: clearly separated,
              rendered as markdown, visually prominent. */}
          <div
            style={{
              marginTop: 4,
              marginBottom: 10,
              border: '1px solid var(--border, #e5e5e5)',
              borderRadius: 10,
              padding: '10px 14px',
              background: 'var(--surface-2, #f6f6f6)',
            }}
          >
            <div className="section-title" style={{ marginTop: 0 }}>{run.nodes && run.nodes.length > 0 ? 'Final output' : 'Run output'}</div>
            {run.output ? (
              <Markdown>{run.output}</Markdown>
            ) : (
              <p className="hint" style={{ margin: 0 }}>(the run produced no final text)</p>
            )}
          </div>

          {/* Path, governed-call counts and the raw tool-call table are run DETAIL —
              in Simple mode they belong under Evaluate (mirrored below), so Run stays
              progress + final result. Developer mode ('all') keeps them here, unchanged. */}
          {phase === 'all' ? (
          <>
          <div><strong>Path:</strong> <span className="mono">{run.path.join(' → ')} → END</span></div>
          <div style={{ marginTop: 6 }}>
            <span className="badge ok">{run.steps.length} governed call{run.steps.length === 1 ? '' : 's'}</span>{' '}
            <span className="badge">{run.traces} trace{run.traces === 1 ? '' : 's'}</span>{' '}
            {run.held > 0 ? <span className="badge warn">{run.held} held for approval ↗ Governance</span> : <span className="badge ok">no approvals needed</span>}
            {run.mode === 'offline-mock' ? <span className="badge" style={{ marginLeft: 6 }}>offline mock</span> : null}
          </div>

          {/* Step-by-step: the plan→act tool calls the agent actually made. */}
          {run.steps.length > 0 ? (
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>#</th><th>Agent</th><th>Tool call</th><th>Decision</th></tr></thead>
                <tbody>
                  {run.steps.map((s, i) => (
                    <tr key={`${s.node}-${s.tool}-${i}`}>
                      <td className="mono">{i + 1}</td>
                      <td className="mono">{s.node}</td>
                      <td className="mono">{s.tool}</td>
                      <td>
                        <span className={`badge ${EFFECT_BADGE[s.effect] ?? ''}`}>{s.effect}</span>
                        {s.ran === false ? <span className="b-off" style={{ marginLeft: 6 }}>not run</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          </>
          ) : null}
          </>
          ) : null}

          {/* EVALUATE-phase assessment: the diagnostics table, the context roll-up and
              the Langfuse trace link. The Evaluate PDF button lives in the Evaluate
              step above this panel (it owns the checks + AI-judge state). In Developer
              mode (phase 'all') the combined run+assessment PDF shows in the Run header. */}
          {showEvaluate ? (
          <>
          {/* Run-level roll-up: what the whole run actually read/retrieved/wrote (#177). */}
          <ContextRollup run={run} />
          {/* Per-agent breakdown — in Simple mode the run's step-by-step detail lives HERE
              (understanding the run IS evaluating it): the per-agent cards, the path, the
              governed-call counts and the raw tool-call table. Developer mode ('all') shows
              these in the Run block above instead, so they are not repeated here. */}
          {phase !== 'all' ? (
            <>
              <TeamStepByStep run={run} openNodes={openNodes} openSteps={openSteps} toggleNode={toggleNode} toggleStep={toggleStep} labelOf={labelOf} />
              <div><strong>Path:</strong> <span className="mono">{run.path.join(' → ')} → END</span></div>
              <div style={{ marginTop: 6, marginBottom: 4 }}>
                <span className="badge ok">{run.steps.length} governed call{run.steps.length === 1 ? '' : 's'}</span>{' '}
                <span className="badge">{run.traces} trace{run.traces === 1 ? '' : 's'}</span>{' '}
                {run.held > 0 ? <span className="badge warn">{run.held} held for approval ↗ Governance</span> : <span className="badge ok">no approvals needed</span>}
                {run.mode === 'offline-mock' ? <span className="badge" style={{ marginLeft: 6 }}>offline mock</span> : null}
              </div>
              {run.steps.length > 0 ? (
                <div className="table-wrap" style={{ marginTop: 10, marginBottom: 4 }}>
                  <table>
                    <thead><tr><th>#</th><th>Agent</th><th>Tool call</th><th>Decision</th></tr></thead>
                    <tbody>
                      {run.steps.map((s, i) => (
                        <tr key={`ev-${s.node}-${s.tool}-${i}`}>
                          <td className="mono">{i + 1}</td>
                          <td className="mono">{s.node}</td>
                          <td className="mono">{s.tool}</td>
                          <td>
                            <span className={`badge ${EFFECT_BADGE[s.effect] ?? ''}`}>{s.effect}</span>
                            {s.ran === false ? <span className="b-off" style={{ marginLeft: 6 }}>not run</span> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          ) : null}
          {/* DIAGNOSTICS — a compact, one-scroll summary of the whole run: one row per
              agent, its governed calls + decision + model tier, enriched with Langfuse
              tokens/latency/cost when the trace store is reachable (honest note when not). */}
          {(() => {
            const diag = buildDiagnostics(runToDiag(run), metrics ?? undefined);
            if (diag.rows.length === 0) return null;
            const t = diag.totals;
            const showMetrics = diag.traceMetricsAvailable;
            return (
              <div style={{ marginTop: 12 }}>
                <div className="section-title" style={{ marginTop: 0 }}>Diagnostics</div>
                <p className="hint" style={{ marginTop: 0 }}>
                  {showMetrics
                    ? 'One row per agent, with tokens, latency and cost read back from the Langfuse trace.'
                    : 'One row per agent from the run’s own steps. Trace metrics unavailable — Langfuse may be down or still ingesting.'}
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Agent</th>
                        <th>Model · tier</th>
                        <th>Calls</th>
                        <th>Decision</th>
                        {showMetrics ? <><th>Tokens</th><th>Latency</th><th>Cost</th></> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {diag.rows.map((r) => (
                        <tr key={r.agent}>
                          <td className="mono">{r.agent}</td>
                          <td className="mono" style={{ fontSize: 11.5, opacity: 0.85 }}>
                            {[r.model, r.tier].filter(Boolean).join(' · ') || '—'}
                          </td>
                          <td className="mono">{r.calls}</td>
                          <td>
                            <span className={`badge ${NODE_STATUS_BADGE[r.decision]}`}>{NODE_STATUS_LABEL[r.decision]}</span>
                            {r.denied > 0 ? <span className="badge warn" style={{ marginLeft: 4 }}>{r.denied} denied</span> : null}
                            {r.errors > 0 ? <span className="badge err" style={{ marginLeft: 4 }}>{r.errors} err</span> : null}
                          </td>
                          {showMetrics ? (
                            <>
                              <td className="mono">{r.tokens != null ? Math.round(r.tokens) : '—'}</td>
                              <td className="mono">{r.latencyMs != null ? `${Math.round(r.latencyMs)}ms` : '—'}</td>
                              <td className="mono">{r.costUsd != null ? `$${r.costUsd.toFixed(4)}` : '—'}</td>
                            </>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td className="mono" style={{ fontWeight: 600 }}>Total</td>
                        <td className="hint">{t.nodes} agent{t.nodes === 1 ? '' : 's'}</td>
                        <td className="mono" style={{ fontWeight: 600 }}>{t.calls}</td>
                        <td className="hint">{t.denied} denied · {t.errors} err</td>
                        {showMetrics ? (
                          <>
                            <td className="mono" style={{ fontWeight: 600 }}>{t.tokens != null ? Math.round(t.tokens) : '—'}</td>
                            <td className="mono" style={{ fontWeight: 600 }}>{t.latencyMs != null ? `${Math.round(t.latencyMs)}ms` : '—'}</td>
                            <td className="mono" style={{ fontWeight: 600 }}>{t.costUsd != null ? `$${t.costUsd.toFixed(4)}` : '—'}</td>
                          </>
                        ) : null}
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            );
          })()}

          {/* Grants vs. usage (#177 Phase 4): granted-but-unused = a muted "dead grant". */}
          {run.grantedIds ? <GrantsVsUsage granted={run.grantedIds} usage={run.contextUsage} /> : null}

          {/* Trace store: honest note when the durable store is down; deep-link when up. */}
          <div className="hint" style={{ marginTop: 8 }}>
            {run.traceStoreAvailable && run.traceUrl ? (
              <>Full trace: <a href={run.traceUrl} target="_blank" rel="noreferrer">open in Langfuse ↗</a></>
            ) : (
              <>Live trace store unavailable — showing the in-run steps above (the durable Langfuse trace may lag or be down).</>
            )}
          </div>
          </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
