/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useReducer, useRef, useState } from 'react';
import Link from 'next/link';
import Markdown from '@core/ui/Markdown';
import { useTranslations, useFormat, useServerMessage } from '@core/i18n/client';
import ProgressStepper, { type Step } from '@core/ui/core/ProgressStepper';
import {
  buildDiagnostics,
  buildRunReport,
  reportFilename,
  type DiagNode,
  type DiagRun,
  type TraceMetrics,
} from '@tabs/agents/lib/build/run-diagnostics';
import { useUser } from '@core/ui/useUser';
import {
  deriveContextUsage,
  deriveContextUsageByNode,
  deepLinkFor,
  usedCount,
  type ContextItem,
  type ContextKind,
  type RunContextUsage,
} from '@tabs/agents/lib/build/context-usage';
import type { System } from '@tabs/agents/lib/system-schema';
import { downloadRunPdf } from '@tabs/agents/lib/build/agent-pdf';
import { agentDisplayName } from '@tabs/agents/lib/build/eval-report';
import { isRunOver, parseSseChunk, reattachFrom, runStreamUrl, REATTACH_LIMIT } from '@tabs/agents/lib/build/run-stream-client';
import { announceRunStarted, onRunStartedElsewhere, runLabelParts, runViewReducer, seedRunView, type RunViewAction, type RunViewState } from '@tabs/agents/lib/build/run-view';
import RunOutputs from '@tabs/agents/ui/RunOutputs';
import type { OutputResult } from '@tabs/agents/lib/output-saver';
import type { GrantWarning } from '@tabs/agents/lib/grant-access';

/**
 * Build = execute + verify (Task 4) and Run (Task 7). Build runs the 5 adapters
 * (opa / litellm / langgraph / langfuse) apply→verify and shows an
 * inline ✓/✗ row per tool with the exact error — a row is ✓ ONLY when BOTH apply
 * AND verify pass, so Build can never report success without a real check. Run
 * fires a test invocation through the governed gateway (every tool call OPA-checked
 * + Langfuse-traced); any write that needs approval is held in the Governance queue.
 */

/** The `agents` translator, handed to the plain helpers below. */
type T = ReturnType<typeof useTranslations<'agents'>>;

type BuildStatus = 'ok' | 'fail' | 'pending' | 'warn';
type BuildChange = 'created' | 'updated' | 'unchanged' | 'reapplied';
type BuildRow = { tool: string; applied: boolean; verified: boolean; status: BuildStatus; detail: string; error?: string; change?: BuildChange; appliedDetail?: string };
// What a build step actually did — so a rebuild that finishes in a blink is understandable:
// `agents.run.build.change.<change>` ("Created" / "Updated" / "Already in place" / "Applied again").
/** `grantWarnings`: the PRE-BUILD CHECK — grants the builder cannot use. Only on a fresh build
 *  response (not persisted with `lastBuild`); a warning, never part of `ok`. */
type BuildReport = { ok: boolean; rows: BuildRow[]; grantWarnings?: GrantWarning[]; grantCheck?: { checked: boolean; reason?: string } };
type LastBuild = { ok: boolean; at: number; rows: BuildRow[] };
type ActivityMarker = { kind: 'building' | 'running'; startedAt: number; /** The run in progress, when the run store knows it. */ runId?: string };
type LastRun = {
  at: number;
  /** When the run began (run store). Absent on a run read from the system record. */
  startedAt?: number;
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
  /** Honest write accounting — direct My-scope writes vs writes held in Governance. */
  writeSummary?: WriteSummary;
  mode?: 'live' | 'offline-mock';
  traceStoreAvailable?: boolean;
  traceUrl?: string;
  /** The run ended because an agent failed (it stopped there) — with the agent and the reason. */
  failed?: boolean;
  failedNode?: string;
  failureReason?: string;
  /** Set when this run was recovered after a mid-run restart — the completed steps
   *  are preserved and the UI shows an "interrupted — re-run to continue" banner. */
  interrupted?: boolean;
  /** Node index the interrupted walk reached (for a future full-resume). */
  resumeFromIndex?: number;
  /** The run id (= LangGraph thread id) under the langgraph engine — what Resume continues. */
  runId?: string;
  /** Where the thread's checkpoints live — Resume is offered only for `postgres` (memory died with the pod). */
  checkpointer?: 'postgres' | 'memory';
  heldApprovals?: HeldApproval[];
  warnings?: string[];
  /** What happened to each declared output of this run ("Where the results go"). */
  outputs?: OutputResult[];
};

/** Grant ids per kind, mirroring ContextKind — for the Evaluate granted-vs-used strip. */
type GrantedIds = Record<ContextKind, string[]>;

/** The run's honest write accounting — direct My-scope writes vs writes held for approval. */
type WriteSummary = {
  line: string;
  wrote: { tab: string; count: number }[];
  /** Direct tool writes + declared outputs saved. */
  wroteTotal: number;
  heldTotal: number;
  /** Declared outputs the OS saved after the run (absent on older runs). */
  outputsSaved?: number;
};

/** Formats a Unix-ms timestamp as a compact relative time string. */
function timeAgo(atMs: number, t: T): string {
  const secs = Math.floor((Date.now() - atMs) / 1000);
  if (secs < 60) return t('run.ago.seconds', { count: secs });
  const mins = Math.floor(secs / 60);
  if (mins < 60) return t('run.ago.minutes', { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t('run.ago.hours', { count: hrs });
  return t('run.ago.days', { count: Math.floor(hrs / 24) });
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
  writeSummary?: WriteSummary;
  mode?: 'live' | 'offline-mock';
  traceStoreAvailable?: boolean;
  traceUrl?: string;
  /** Engine rebuild A1/A2: the run id (= LangGraph thread), where its checkpoints live, compile warnings. */
  runId?: string;
  checkpointer?: 'postgres' | 'memory';
  warnings?: string[];
  interrupted?: boolean;
  /** A2: the run is PARKED on these approvals; the decision in Governance resumes it. */
  parked?: boolean;
  heldApprovals?: HeldApproval[];
  /** The run ended because an agent FAILED: it stopped there and nothing after it ran. */
  failed?: boolean;
  failedNode?: string;
  failureReason?: string;
  outputs?: OutputResult[];
};
type HeldApproval = { approvalId: string; tool: string; node: string };

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
type RawRun = Partial<RunReport> & {
  team?: boolean;
  finalText?: string;
  nodes?: TeamNode[];
  contextUsage?: RunContextUsage;
  grantedIds?: GrantedIds;
  writeSummary?: WriteSummary;
  /** The live report names the failure as one object; the stored last run as two flat fields. */
  failure?: { node: string | null; reason: string };
};

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
    writeSummary: body.writeSummary,
    mode: body.mode,
    traceStoreAvailable: body.traceStoreAvailable,
    traceUrl: body.traceUrl,
    runId: body.runId,
    checkpointer: body.checkpointer,
    warnings: Array.isArray(body.warnings) ? body.warnings : undefined,
    interrupted: body.interrupted,
    parked: body.parked ?? ((body.heldApprovals?.length ?? 0) > 0),
    heldApprovals: Array.isArray(body.heldApprovals) ? body.heldApprovals : undefined,
    failed: body.failed === true,
    failedNode: body.failedNode ?? body.failure?.node ?? undefined,
    failureReason: body.failureReason ?? body.failure?.reason,
    outputs: Array.isArray(body.outputs) ? body.outputs : undefined,
  };
}

const EFFECT_BADGE: Record<string, string> = { allow: 'ok', deny: 'warn', error: 'err', requires_approval: 'warn' };
// 'denied' = a real policy block (warn amber, not alarming red); 'error' = an execution
// failure (neutral, not a governance verdict); 'failed' = the node itself threw.
const NODE_STATUS_BADGE: Record<NodeStatus, string> = { ok: 'ok', denied: 'warn', error: 'err', failed: 'err' };
// The status word is `agents.diagnostics.status.<status>` ("✓ ok" / "denied" / "error" / "✗ failed").

/**
 * The real build phases — the SAME work the server's 4 adapters do (opa · litellm ·
 * langgraph · langfuse), in order, described in plain words. The build route
 * is a single call (no per-stage stream), so the stepper advances through these on a
 * gentle timer while the build is in flight, then settles on the real ✓/✗ outcome the
 * moment the report lands. Honest: these are the actual phases, not invented steps.
 */
// `key` is also the label's catalog key: `agents.run.build.stages.<key>`.
const BUILD_STAGES: { key: 'grants' | 'graph' | 'trace' | 'commit'; tools: string[] }[] = [
  { key: 'grants', tools: ['opa', 'litellm'] },
  { key: 'graph', tools: ['langgraph'] },
  { key: 'trace', tools: ['langfuse'] },
  { key: 'commit', tools: [] },
];

/**
 * A tasteful, determinate build stepper. While `building`, it walks BUILD_STAGES on a
 * timer (the build is one call, so we pace it); on completion it reflects the REAL
 * outcome — every stage ✓ when the report is green, or the failing stage(s) marked ✗
 * from the report rows. `done` + `ok` come from the landed report.
 */
function BuildProgress({ building, report }: { building: boolean; report: BuildReport | null }) {
  const t = useTranslations('agents');
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
    return { key: st.key, label: t(`run.build.stages.${st.key}`), state: failed ? 'fail' : complete ? 'done' : active ? 'active' : 'pending' };
  });
  steps.push({
    key: 'ready',
    label: done ? (report?.ok ? t('run.build.stages.ready') : t('run.build.stages.failedSeeBelow')) : t('run.build.stages.ready'),
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
function stepBadge(s: NodeStep): { cls: string; label: 'stepOk' | 'stepDenied' | 'stepError' } {
  if (!s.isError) return { cls: 'ok', label: 'stepOk' };
  return s.errorKind === 'policy' ? { cls: 'warn', label: 'stepDenied' } : { cls: 'err', label: 'stepError' };
}

/** A one-line, human summary of the whole run: did it work, and how far did it get. */
function runSummary(run: RunReport, t: T): string {
  const last = run.path[run.path.length - 1];
  const calls = run.steps.length;
  const nodes = run.nodes ?? [];
  const failed = nodes.find((n) => n.status === 'failed');
  if (failed) return t('run.summary.failedAt', { node: failed.node, calls });
  const capped = !!run.output && /tool[- ]step budget|tool step limit|step limit \(cap\)/i.test(run.output);
  if (capped) return t('run.summary.stoppedCap', { calls });
  return last ? t('run.summary.completedThrough', { last, calls }) : t('run.summary.completed', { calls });
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
  /** A2: the held write the run is parked on right now (cleared by `resumed`). */
  awaiting?: HeldApproval;
  /** A2: the last decision that resumed the run. */
  resumed?: { approvalId: string; decision: string };
  /** The agent is waiting for the model rate limit to reset (cleared by its next event). */
  waiting?: string;
  /** The team finished; its declared outputs are being saved where they were declared. */
  savingOutputs?: number;
};

// ── Context actually used (#177) ────────────────────────────────────────────
/** Human label + tab route per artifact kind. Files live under /unstructured. The
 *  per-ITEM deep link comes from `deepLinkFor(kind,id)`; this is the tab-level fallback
 *  used for the "kind" group label and when an item has no resolvable item id. */
// The label of each kind is `agents.diagnostics.context.kind.<kind>`.
const KIND_META: Record<ContextKind, { href: string }> = {
  data: { href: '/data' },
  files: { href: '/unstructured' },
  knowledge: { href: '/knowledge' },
  workflows: { href: '/workflows' },
  metrics: { href: '/metrics' },
  connections: { href: '/connections' },
};
const KIND_ORDER: ContextKind[] = ['data', 'files', 'knowledge', 'workflows', 'metrics', 'connections'];

// The read/retrieved/written verb shown on each chip is `agents.diagnostics.context.mode.<mode>`.

/**
 * One artifact chip — a real same-app deep link to the item (its tab, `?focus=<id>`),
 * showing HOW it was used: the mode verb, the tool (`via`), a short arg hint when we
 * have one, and honest markers. Errored calls are muted and read "not obtained" (the
 * context was never actually gained); inferred ids are flagged and, having no resolvable
 * item id, fall back to opening the tab.
 */
function ContextChip({ item }: { item: ContextItem }) {
  const t = useTranslations('agents');
  const label = item.name ? `${item.name} (${item.id})` : item.id;
  // Prefer the derived per-item deep link; else recompute; else fall back to the tab.
  const href = item.deepLink ?? deepLinkFor(item.kind, item.id) ?? KIND_META[item.kind].href;
  const mode = t(`diagnostics.context.mode.${item.mode}`);
  const modeText = item.errored ? t('diagnostics.context.notObtained') : mode;
  const title = [
    t('diagnostics.context.via', { mode, tool: item.via }),
    ...(item.hint ? [item.hint] : []),
    ...(item.errored ? [t('diagnostics.context.callFailed')] : []),
    ...(item.confidence === 'inferred' ? [t('diagnostics.context.inferred')] : []),
  ].join(' — ');
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
      {item.confidence === 'inferred' ? <span className="hint" style={{ fontSize: 10, opacity: 0.7 }}>{t('diagnostics.context.inferredMark')}</span> : null}
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
  const t = useTranslations('agents');
  const rows = dedupeItems(items);
  if (rows.length === 0) return null;
  const groups = KIND_ORDER.map((k) => ({ kind: k, items: rows.filter((r) => r.kind === k) })).filter((g) => g.items.length > 0);
  return (
    <div>
      <div className="hint" style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {groups.map((g) => (
          <div key={g.kind} style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span className="hint" style={{ fontSize: 11, minWidth: 78 }}>{t(`diagnostics.context.kind.${g.kind}`)}</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {g.items.map((it, i) => <ContextChip key={`${it.id}-${it.mode}-${i}`} item={it} />)}
            </div>
          </div>
        ))}
      </div>
      <p className="hint" style={{ fontSize: 10.5, marginTop: 6, opacity: 0.75 }}>
        {t('diagnostics.context.note')}
      </p>
    </div>
  );
}

/** Context items scoped to ONE node — re-derived from that node's own tool steps. */
function nodeContextItems(node: RunNode): ContextItem[] {
  return deriveContextUsage([{ steps: node.steps }]).items;
}

/**
 * The honest WRITE-OUTCOME banner: "wrote N record(s) to My <tab>" for direct My-scope
 * writes and "M write(s) awaiting approval in Governance → Inbox" for held ones. Counts
 * come straight off `run.writeSummary` (the server counted them from real steps), so it
 * never over- or under-reports. Renders nothing when the run wrote nothing (the common
 * read-only case) so it doesn't add noise.
 */
/** "Wrote 1 item (1 output saved)" · "Wrote 2 directly — 2 to My Data" · both, joined. */
function wroteText(s: WriteSummary, t: T): string {
  const saved = s.outputsSaved ?? 0;
  const direct = s.wroteTotal - saved;
  // `tab` is the server's tab name for the write target.
  const groups = s.wrote.map((g) => t('run.writes.group', { count: g.count, tab: g.tab })).join(', ');
  if (saved === 0) return groups ? t('run.writes.directGroups', { direct, groups }) : t('run.writes.direct', { direct });
  if (direct === 0) return t('run.writes.saved', { saved });
  return groups
    ? t('run.writes.bothGroups', { total: s.wroteTotal, direct, groups, saved })
    : t('run.writes.both', { total: s.wroteTotal, direct, saved });
}

function WriteOutcomeBanner({ writeSummary }: { writeSummary?: WriteSummary }) {
  const t = useTranslations('agents');
  if (!writeSummary || (writeSummary.wroteTotal === 0 && writeSummary.heldTotal === 0)) return null;
  return (
    <div
      style={{
        marginTop: 0, marginBottom: 10, padding: '8px 12px',
        border: '1px solid var(--border, #e5e5e5)', borderRadius: 10,
        display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center',
      }}
    >
      {writeSummary.wroteTotal > 0 ? (
        <span className="badge ok">{wroteText(writeSummary, t)}</span>
      ) : null}
      {writeSummary.heldTotal > 0 ? (
        <span className="badge warn">{t('run.writes.awaiting', { count: writeSummary.heldTotal })}</span>
      ) : null}
    </div>
  );
}

/**
 * Run-level roll-up at the top of Evaluate: a count-per-kind summary line + the full
 * deduped chip list of everything the whole run touched. Empty → renders nothing.
 */
function ContextRollup({ run }: { run: RunReport }) {
  const t = useTranslations('agents');
  const usage = run.contextUsage;
  const items = usage?.items ?? [];
  if (items.length === 0) return null;
  const counts = KIND_ORDER
    .map((k) => ({ k, n: usedCount(usage, k) }))
    .filter((c) => c.n > 0);
  return (
    <div style={{ marginBottom: 14, padding: '10px 12px', border: '1px solid var(--border, #e5e5e5)', borderRadius: 10 }}>
      <div className="section-title" style={{ marginTop: 0 }}>{t('diagnostics.context.usedTitle')}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {counts.map((c) => (
          <span key={c.k} className="badge">{t('diagnostics.context.count', { kind: t(`diagnostics.context.kind.${c.k}`), count: c.n })}</span>
        ))}
      </div>
      <ContextUsed items={items} title={t('diagnostics.context.everything')} />
    </div>
  );
}

/**
 * The Evaluate "Grants vs. usage" strip: for each granted artifact, is it USED (green)
 * or a granted-but-unused "dead grant" (muted). Reads grants + used ids off the run —
 * never edits the grant editor. Renders nothing when no grants were recorded.
 */
function GrantsVsUsage({ granted, usage }: { granted: GrantedIds; usage?: RunContextUsage }) {
  const t = useTranslations('agents');
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
      <div className="section-title" style={{ marginTop: 0 }}>{t('diagnostics.grants.title')}</div>
      <p className="hint" style={{ marginTop: 0 }}>
        {t('diagnostics.grants.hint')}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((r) => (
          <div key={r.kind} style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span className="hint" style={{ fontSize: 11, minWidth: 78 }}>{t(`diagnostics.context.kind.${r.kind}`)}</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {r.ids.map((id) => {
                const isUsed = r.used.has(id);
                const href = deepLinkFor(r.kind, id) ?? KIND_META[r.kind].href;
                return (
                  <Link
                    key={id}
                    href={href}
                    className={isUsed ? 'chip ok' : 'chip'}
                    title={isUsed ? t('diagnostics.grants.used') : t('diagnostics.grants.unused')}
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
function liveLine(p: LiveProgress, t: T): string {
  if (p.awaiting) return t('run.live.parked', { node: p.awaiting.node, tool: p.awaiting.tool });
  // `waiting` is the server's own sentence (or our rate-limit fallback), shown as it is.
  if (p.waiting) return p.node ? t('run.live.waitingAt', { node: p.node, message: p.waiting }) : p.waiting;
  if (p.savingOutputs) return t('run.live.saving', { count: p.savingOutputs });
  if (!p.node) {
    if (!p.resumed) return t('run.live.starting');
    return p.resumed.decision === 'approve' ? t('run.live.resumedApprove') : p.resumed.decision === 'withdraw' ? t('run.live.resumedWithdraw') : t('run.live.resumedReject');
  }
  const where = p.index && p.total ? t('run.live.where', { index: p.index, total: p.total }) : '';
  if (!p.tool) return t('run.live.thinking', { node: p.node, where });
  // A status word the panel does not know (a newer server) is shown as it came.
  const st = p.stepStatus ?? 'done';
  const verb = st === 'running' || st === 'ok' || st === 'denied' || st === 'error' || st === 'done' ? t(`run.live.verb.${st}`) : String(st);
  const step = p.stepIndex ? t('run.live.step', { index: p.stepIndex }) : '';
  return t('run.live.toolStep', { node: p.node, tool: p.tool, verb, step, where });
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
  const t = useTranslations('agents');
  if (!run.nodes || run.nodes.length === 0) return null;
  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>{t('diagnostics.team.title')}</div>
      <p className="hint" style={{ marginTop: 0 }}>{t('diagnostics.team.hint')}</p>
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
                <span className={`badge ${NODE_STATUS_BADGE[n.status]}`}>{t(`diagnostics.status.${n.status}`)}</span>
                {n.steps.length > 0 ? <span className="hint" style={{ fontSize: 11 }}>{t('diagnostics.team.toolCalls', { count: n.steps.length })}</span> : null}
                {n.tier ? <span className="badge muted" style={{ marginLeft: 'auto', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.3 }}>{n.tier === 'fast' ? t('diagnostics.team.tierFast') : t('diagnostics.team.tierReasoning')}</span> : null}
                {n.model ? <span className="hint mono" style={{ marginLeft: n.tier ? 0 : 'auto', fontSize: 11, opacity: 0.7 }}>{n.model}</span> : null}
              </button>
              {n.error ? <div className="b-off" style={{ marginTop: 6 }}>{n.error}</div> : null}

              {open ? (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {/* AUTO model routing — why this agent got its tier (zero-cost, deterministic). */}
                  {n.tierReason ? (
                    <div className="hint" style={{ fontSize: 11.5 }}>
                      {t.rich('diagnostics.team.modelReason', {
                        tier: n.tier === 'fast' ? t('diagnostics.team.tierFast') : t('diagnostics.team.tierReasoning'),
                        reason: n.tierReason,
                        strong: (c) => <strong>{c}</strong>,
                      })}
                    </div>
                  ) : null}
                  {/* INPUT — what this agent was given. */}
                  {n.input ? (
                    <div>
                      <div className="hint" style={{ fontWeight: 600, marginBottom: 2 }}>{t('diagnostics.team.input')}</div>
                      <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11.5, maxHeight: 200, overflow: 'auto', background: 'var(--surface-2, #f6f6f6)', borderRadius: 8, padding: '8px 10px' }}>{n.input}</pre>
                    </div>
                  ) : null}
                  {/* OUTPUT — what it produced. */}
                  {n.finalText ? (
                    <div>
                      <div className="hint" style={{ fontWeight: 600, marginBottom: 2 }}>{t('diagnostics.team.output')}</div>
                      <p style={{ margin: 0, whiteSpace: 'pre-wrap', opacity: 0.92 }}>{n.finalText}</p>
                    </div>
                  ) : null}
                  {/* Tool calls — CONSECUTIVE identical rows collapsed to one
                      "tool ×N" line so a 34× error loop reads as a single row. */}
                  {n.steps.length > 0 ? (
                    <div>
                      <div className="hint" style={{ fontWeight: 600, marginBottom: 4 }}>{t('diagnostics.team.toolCallsTitle')}</div>
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
                                <span className={`badge ${badge.cls}`}>{t(`diagnostics.team.${badge.label}`)}</span>
                                <span className="mono">{s.tool}</span>
                                {g.count > 1 ? <span className="mono" style={{ opacity: 0.6 }}>×{g.count}</span> : null}
                                {!sOpen && s.summary ? <span style={{ opacity: 0.7 }}> — {s.summary}</span> : null}
                              </button>
                              {sOpen ? (
                                <div style={{ margin: '4px 0 6px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                                  {s.args ? (
                                    <div>
                                      <div className="hint" style={{ fontSize: 11 }}>{t('diagnostics.team.args')}</div>
                                      <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11.5, maxHeight: 160, overflow: 'auto', background: 'var(--surface-2, #f6f6f6)', borderRadius: 8, padding: '6px 8px' }}>{s.args}</pre>
                                    </div>
                                  ) : null}
                                  {s.result ? (
                                    <div>
                                      <div className="hint" style={{ fontSize: 11 }}>{t('diagnostics.team.result')}</div>
                                      <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11.5, maxHeight: 200, overflow: 'auto', background: 'var(--surface-2, #f6f6f6)', borderRadius: 8, padding: '6px 8px' }}>{s.result}</pre>
                                      {/* Service-account identity label (operational action tools run AS the
                                          integration account, not the human) — self-labeled from the envelope. */}
                                      {s.result.includes('"asServiceAccount":true') || s.result.includes('as the integration account') ? (
                                        <div className="hint" style={{ fontSize: 10.5, marginTop: 4, opacity: 0.75 }}>{t('diagnostics.team.serviceAccount')}</div>
                                      ) : null}
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
                  <ContextUsed items={nodeContextItems(n)} title={t('diagnostics.context.agentUsed')} />
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
  canRun: canRunProp,
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
  /** When true, the Run button is enabled even for non-editors (in-domain consumers of a Shared system). */
  canRun?: boolean;
  lastBuild?: LastBuild | null;
  activity?: ActivityMarker | null;
  lastRun?: LastRun | null;
  /** The team's node path — shown as an immediate in-progress affordance on Run. */
  nodePath?: string[];
  onStateChange: () => void;
  /**
   * Which sections to render. Simple mode's guided flow reuses this ONE panel but
   * shows only the section(s) for the current phase: `'build'` = compile+verify only,
   * `'run'` = the run trigger + results, `'build-run'` = BOTH build and run in one merged
   * "Build & Run" stage (no assessment), `'evaluate'` = the assessment (diagnostics table,
   * Langfuse link, PDF). Developer mode passes nothing → `'all'`, so it is unchanged.
   */
  phase?: 'all' | 'build' | 'run' | 'build-run' | 'evaluate';
}) {
  // canRunProp absent → fall back to canEdit (back-compat with callers that haven't
  // threaded the new prop yet, e.g. SimpleBuilder). When present, use it as the
  // authoritative gate: the server already enforces run authz; the UI just surfaces it.
  const t = useTranslations('agents');
  const msg = useServerMessage();
  const f = useFormat();
  const canRun = canRunProp !== undefined ? canRunProp : canEdit;
  const showBuild = phase === 'all' || phase === 'build' || phase === 'build-run';
  const showRun = phase === 'all' || phase === 'run' || phase === 'build-run';
  const showEvaluate = phase === 'all' || phase === 'evaluate';
  const [building, setBuilding] = useState(false);
  // Seed from server-persisted lastBuild so the panel survives tab-switches.
  const [report, setReport] = useState<BuildReport | null>(lastBuild ?? null);
  // Track the timestamp of the currently displayed report (null = never built).
  const [builtAt, setBuiltAt] = useState<number | null>(lastBuild?.at ?? null);
  const [buildErr, setBuildErr] = useState('');
  // Folders the definition names that Build could not create (a Domain folder needs a domain admin).
  const [folderWarnings, setFolderWarnings] = useState<string[]>([]);
  // Does this system have a usable model key of its own? A run without one is refused (it is
  // never moved onto the shared key), so say "Build needed" here, before the run fails. Read on
  // mount and after every build. `null` = not known (yet, or the read failed) → no notice.
  const [keyNotice, setKeyNotice] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/agents/systems/${systemId}/model-key`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { state?: string; message?: string | null } | null) => {
        if (!cancelled) setKeyNotice(b && b.state && b.state !== 'ready' ? (b.message ?? t('run.build.noModelKey')) : null);
      })
      .catch(() => { if (!cancelled) setKeyNotice(null); });
    return () => { cancelled = true; };
  }, [systemId, builtAt]);

  const [prompt, setPrompt] = useState('');
  // Whether the optional "add input for this run" field is revealed. Default hidden:
  // the primary affordance is a one-click ▶ Run of the task defined in Define.
  const [showInput, setShowInput] = useState(false);
  const [runningNow, setRunningNow] = useState(false);
  // WHICH run is shown, and where it came from. Seeded from the server's stored latest run
  // (labelled "Last run"); a run followed here replaces it as "This run". See `run-view.ts`.
  const [view, dispatchRun] = useReducer(
    runViewReducer as (s: RunViewState<RunReport>, a: RunViewAction<RunReport>) => RunViewState<RunReport>,
    lastRun ?? null,
    seedRunView<RunReport>,
  );
  const run = view.run;
  const [runErr, setRunErr] = useState('');
  /** The approval id of a held call being withdrawn right now ('' when none). */
  const [withdrawing, setWithdrawing] = useState('');
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

  // The stored latest run arrived or changed (a reload after ANY panel's run): show it — unless a
  // run is being followed here, or what is on screen is a newer result than the stored one. A
  // panel used to copy `lastRun` once at mount and then kept that run for as long as it lived.
  useEffect(() => {
    dispatchRun({ type: 'stored', run: lastRun ?? null, busy: runningNow });
  }, [lastRun, runningNow]);

  // Two panels of one system can share a screen (Run above, Evaluate below). When the OTHER one
  // starts a run, drop this panel's run in the same tick; the reload after the run brings the new one.
  const panelId = useRef<object>({});
  useEffect(() => onRunStartedElsewhere(systemId, panelId.current, () => dispatchRun({ type: 'cleared' })), [systemId]);

  /** A cost in US dollars with four decimals ("$0.0123" in English). */
  const usd = (v: number) => f.currency(v, 'USD', { minimumFractionDigits: 4, maximumFractionDigits: 4 });

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
    // A3: read BY THE RUN'S TRACE ID (= run id); a run recorded before the rebuild (no run id) is bounded server-side to
    // this user's own recent traces. Never an unfiltered read.
    const scope = run.runId ? `&runId=${encodeURIComponent(run.runId)}` : '';
    fetch(`/api/agents/systems/${systemId}/run/diagnostics?nodes=${encodeURIComponent(nodes)}${scope}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { metrics?: TraceMetrics } | null) => { if (!cancelled) setMetrics(b?.metrics ?? null); })
      .catch(() => { if (!cancelled) setMetrics(null); });
    return () => { cancelled = true; };
    // Re-fetch per distinct run: the run id, and the path for a run recorded without one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runComplete, systemId, run?.runId, run?.path.join('>')]);

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
        at: view.at ?? Date.now(),
        prompt,
      });
    } catch (e) {
      setRunErr(t('run.pdf.failed', { reason: (e as Error).message }));
    } finally {
      setPdfBusy(false);
    }
  };

  /**
   * Build + download a clean, legible PDF of the current run (client-side, offline-safe).
   * i18n: the report stays English for now — its rows come from the English report builders in
   * `run-diagnostics.ts` / `agent-pdf.ts`, which a later wave converts together.
   */
  const downloadPdf = async () => {
    if (!run) return;
    setPdfBusy(true);
    try {
      const [{ jsPDF }, autoTableMod] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
      const autoTable = autoTableMod.default;
      const diag = buildDiagnostics(runToDiag(run), metrics ?? undefined);
      const at = view.at ?? Date.now();
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
      setRunErr(t('run.pdf.failed', { reason: (e as Error).message }));
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
      if (!res.ok) setBuildErr(msg(body, t('run.build.failed')));
      else {
        setReport(body as BuildReport);
        setBuiltAt(Date.now());
        setFolderWarnings(((body as { folders?: { warnings?: { message: string }[] } }).folders?.warnings ?? []).map((w) => w.message));
      }
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
        waiting: undefined,
        started: p?.started.includes(node) ? p.started : [...(p?.started ?? []), node],
      }));
    } else if (event === 'tool-step') {
      setLive((p) => ({
        ...(p ?? { started: [], completed: [] }),
        node: String(data.node ?? p?.node ?? ''),
        tool: String(data.tool ?? ''),
        stepStatus: (data.status as LiveStepStatus) ?? 'running',
        stepIndex: typeof data.index === 'number' ? data.index : undefined,
        waiting: undefined,
      }));
    } else if (event === 'node-completed') {
      const node = String(data.node ?? '');
      setLive((p) => ({
        ...(p ?? { started: [], completed: [] }),
        completed: p?.completed.includes(node) ? p.completed : [...(p?.completed ?? []), node],
      }));
    } else if (event === 'rate-limit-wait') {
      // The agent is waiting for the model rate limit to reset — show it instead of a silent spinner.
      setLive((p) => ({
        ...(p ?? { started: [], completed: [] }),
        node: String(data.node ?? p?.node ?? ''),
        waiting: String(data.message ?? t('run.live.rateLimit')),
      }));
    } else if (event === 'approval-required') {
      // A2: a held write parked the run — say so, and keep the banner until the decision resumes it.
      setLive((p) => ({
        ...(p ?? { started: [], completed: [] }),
        awaiting: { approvalId: String(data.approvalId ?? ''), tool: String(data.tool ?? ''), node: String(data.node ?? '') },
      }));
    } else if (event === 'outputs-saving') {
      const n = Array.isArray(data.outputs) ? data.outputs.length : 0;
      setLive((p) => ({ ...(p ?? { started: [], completed: [] }), savingOutputs: n || undefined }));
    } else if (event === 'resumed') {
      setLive((p) => ({
        ...(p ?? { started: [], completed: [] }),
        awaiting: undefined,
        resumed: { approvalId: String(data.approvalId ?? ''), decision: String(data.decision ?? '') },
      }));
    }
  };

  /**
   * Consume one SSE response frame-by-frame. `onFrame` returns true to stop reading (a terminal
   * frame). Resolves `settled` = whether a terminal frame arrived (never a stuck spinner otherwise).
   */
  const readSse = async (res: Response, onFrame: (event: string, data: Record<string, unknown>) => boolean): Promise<boolean> => {
    if (!res.body) return false;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let settled = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      // Frame splitting lives in `run-stream-client.ts` (pure, unit-tested): a frame can arrive
      // across two network chunks, and a frame we cannot read must not break the stream.
      const parsed = parseSseChunk(buf, decoder.decode(value, { stream: true }));
      buf = parsed.rest;
      for (const frame of parsed.frames) {
        if (onFrame(frame.event, frame.data)) settled = true;
      }
      if (settled) break;
    }
    return settled;
  };

  /**
   * A2 — re-attach to a run that outlived its request: a PARKED run the Governance decision
   * resumes elsewhere, or (A4-review-M-3) a run whose tail budget expired. The stream replays from
   * `afterSeq` and follows the run to its real end; when the server hands back another `queued`
   * cursor we simply re-attach from it, as many times as the run needs. Nothing asks the user to
   * "run again" while the run is still executing.
   */
  const attachToRun = async (runId: string, afterSeq = 0) => {
    setRunningNow(true);
    setRunErr('');
    let cursor = { runId, afterSeq };
    try {
      for (let hop = 0; hop < REATTACH_LIMIT; hop += 1) {
        const res = await fetch(runStreamUrl(systemId, cursor.runId, cursor.afterSeq), { headers: { accept: 'text/event-stream' } });
        if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
          const body = await res.json().catch(() => ({}));
          setRunErr(msg(body, t('run.errors.attachFailed')));
          return;
        }
        let next: { runId: string; afterSeq: number } | undefined;
        const settled = await readSse(res, (event, data) => {
          const frame = { event, data };
          const again = reattachFrom(frame, cursor.runId);
          if (again) { next = again; return true; }
          if (event === 'done') {
            const r = normalizeRun(data as RawRun);
            dispatchRun({ type: 'result', run: r, at: Date.now() });
            if (!isRunOver(frame)) return false; // the replayed parked `done` — keep listening
            setLive(null);
            return true;
          }
          if (event === 'error') { setRunErr(msg(data, t('run.errors.failed'))); return true; }
          applyEvent(event, data);
          return false;
        });
        if (next) { cursor = next; continue; }
        if (!settled) setRunErr(t('run.errors.attachStreamEnded'));
        onStateChange();
        return;
      }
      setRunErr(t('run.errors.watchedTooLong'));
    } catch (e) {
      setRunErr((e as Error).message);
    } finally {
      setRunningNow(false);
      setLive(null);
    }
  };

  /**
   * Take back a call this run is parked on. The server checks that the run is yours; the call is
   * not executed, and the run resumes without it — so follow it to its end.
   */
  // RE-ATTACH ON MOUNT: a run of mine that is still queued or executing when this panel mounts
  // (I switched tabs and came back, reloaded, or opened another browser) is followed from its
  // first event to its end — its progress, then its result — without pressing anything. The
  // re-attach chain in `run-stream-client.ts` only ever continued a stream this panel had
  // already opened; a freshly mounted panel had no run id to attach to. Once per run id.
  const autoAttached = useRef<string | null>(null);
  const inFlightRunId = activity?.kind === 'running' ? activity.runId : undefined;
  useEffect(() => {
    if (!showRun || !inFlightRunId || runningNow || autoAttached.current === inFlightRunId) return;
    autoAttached.current = inFlightRunId;
    void attachToRun(inFlightRunId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRun, inFlightRunId, runningNow]);

  const withdrawHeld = async (approvalId: string) => {
    if (withdrawing) return;
    setWithdrawing(approvalId);
    setRunErr('');
    try {
      const res = await fetch('/api/governance/approvals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: approvalId, decision: 'withdraw' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRunErr(msg(body, t('run.withdrawFailed', { status: res.status })));
        return;
      }
      const runId = run?.runId;
      if (runId) await attachToRun(runId);
      else onStateChange();
    } catch (e) {
      setRunErr((e as Error).message);
    } finally {
      setWithdrawing('');
    }
  };

  const doRun = async (stop = false, resumeRunId?: string) => {
    setRunningNow(true);
    setRunErr('');
    // Immediately clear EVERYTHING that belongs to the prior run — result, context card, counters,
    // warnings, failure banner (all read `run`), trace metrics and the open drill-downs — before
    // the first event arrives, so nothing of an earlier run can sit next to this one.
    // (A stop press keeps the last result visible. A resume continues the SAME run, so it keeps
    // that run's start time.)
    if (!stop) {
      const resumingShown = !!resumeRunId && run?.runId === resumeRunId;
      dispatchRun({ type: 'started', at: resumingShown && view.startedAt !== null ? view.startedAt : Date.now() });
      announceRunStarted(systemId, panelId.current);
      setLive(null);
      setMetrics(null);
      setOpenNodes({});
      setOpenSteps({});
    }
    try {
      const res = await fetch(`/api/agents/systems/${systemId}/run`, {
        method: 'POST',
        // Ask for live SSE progress on a run (not on a stop). The server keeps a
        // non-streaming JSON fallback for callers that don't request the stream.
        headers: { 'content-type': 'application/json', ...(stop ? {} : { accept: 'text/event-stream' }) },
        // Send the typed task; an empty prompt lets the server fill a real, purpose-derived
        // default task (NOT "Test invocation"), so the run does the team's actual job.
        // Resume continues an interrupted langgraph thread from its last checkpoint (engine rebuild A1).
        body: JSON.stringify(
          stop ? { stop: true } : resumeRunId ? { resume: true, runId: resumeRunId } : prompt.trim() ? { prompt: prompt.trim() } : {},
        ),
      });

      const isStream = (res.headers.get('content-type') ?? '').includes('text/event-stream');
      if (!stop && isStream && res.body) {
        // Parse the SSE stream frame-by-frame: light up agents as they run and show
        // the current step live; `done` carries the SAME full result the non-stream
        // path returns, so the completed view is byte-for-byte unchanged.
        let follow: { runId: string; afterSeq: number } | undefined;
        const settled = await readSse(res, (event, data) => {
          const frame = { event, data };
          // A4-review-M-3: the server's tail budget ran out — it handed us a cursor, not a
          // failure. Re-attach from it instead of telling the user to run again.
          const again = reattachFrom(frame, resumeRunId);
          if (again) { follow = again; return true; }
          if (event === 'done') {
            const r = normalizeRun(data as RawRun);
            dispatchRun({ type: 'result', run: r, at: Date.now() });
            // A2: a PARKED run — the request is over, but the run is not: re-attach below.
            if (!isRunOver(frame) && r.runId) follow = { runId: r.runId, afterSeq: 0 };
            else setLive(null);
            return true;
          }
          if (event === 'error') { setRunErr(msg(data, t('run.errors.failed'))); return true; }
          applyEvent(event, data);
          return false;
        });
        // Stream ended without a terminal frame (disconnect): never leave a stuck
        // spinner — surface an honest message so the student can retry.
        if (!settled) setRunErr(t('run.errors.streamEnded'));
        if (follow) {
          onStateChange();
          void attachToRun(follow.runId, follow.afterSeq);
          return;
        }
      } else {
        // Non-streaming (stop press, or a server without the stream): read JSON.
        const body = await res.json();
        if (!res.ok) setRunErr(msg(body, t('run.errors.failed')));
        else if (!stop) dispatchRun({ type: 'result', run: normalizeRun(body as RawRun), at: Date.now() });
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
        {phase === 'build' || phase === 'build-run' ? t('run.build.title') : t('run.build.titleLong')}
        <button className="btn lg" style={{ marginLeft: 'auto' }} onClick={doBuild} disabled={building || !canEdit}>
          {building ? <span className="spin" /> : builtAt ? t('run.build.rebuild') : t('run.build.build')}
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
          {t('run.build.inProgressElsewhere', { ago: timeAgo(activity.startedAt, t) })}
        </div>
      ) : null}
      {builtAt ? (
        <div className="hint" style={{ marginTop: 2, marginBottom: 4 }}>
          {t('run.build.lastBuilt', { ago: timeAgo(builtAt, t) })}
          {report ? (
            <>
              {' · '}
              <span className={`badge ${report.ok ? 'ok' : 'err'}`} style={{ fontSize: 11 }}>
                {report.ok
                  ? t('run.build.allGreen')
                  : t('run.build.failing', { count: report.rows.filter((r) => r.status === 'fail').length })}
              </span>
            </>
          ) : null}
        </div>
      ) : null}
      {buildErr ? <div className="error">{buildErr}</div> : null}
      {folderWarnings.map((w) => <div key={w} className="hint" style={{ color: 'var(--amber, #b7791f)' }}>{w}</div>)}
      {keyNotice && !building ? (
        <div className="hint" role="status" style={{ marginTop: 2, marginBottom: 4, color: 'var(--warn, #b7791f)' }}>
          <strong>{builtAt ? t('run.build.rebuildNeeded') : t('run.build.buildNeeded')}</strong> {keyNotice}
        </div>
      ) : null}
      {report?.grantWarnings?.length && !building ? (
        // PRE-BUILD CHECK — a warning, not a failure: the build ran, and access can still change
        // (the owner shares the dataset). At run time each grant is enforced as the runner.
        <div className="hint" role="status" style={{ marginTop: 2, marginBottom: 4, color: 'var(--warn, #b7791f)', whiteSpace: 'normal' }}>
          <strong>{t('run.build.grantWarningTitle', { count: report.grantWarnings.length })}</strong>{' '}
          {t('run.build.grantWarningBody', { count: report.grantWarnings.length })}
          <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
            {report.grantWarnings.map((w) => (
              <li key={`${w.kind}:${w.id ?? `${w.folder?.scope}:${w.folder?.path}`}`}>
                <span className="mono">{w.id ?? w.folder?.path}</span> — {w.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {report?.grantCheck && !report.grantCheck.checked && !building ? (
        <div className="hint" role="status" style={{ marginTop: 2, marginBottom: 4, whiteSpace: 'normal' }}>
          {t('run.build.grantCheckSkipped', { reason: report.grantCheck.reason ?? t('run.build.unknownReason') })}
        </div>
      ) : null}
      {report ? (
        <div className="table-wrap" style={{ marginTop: 4 }}>
          <table>
            <thead><tr><th>{t('run.build.table.tool')}</th><th>{t('run.build.table.status')}</th><th>{t('run.build.table.detail')}</th></tr></thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.tool}>
                  <td className="mono">{r.tool}</td>
                  <td>
                    {r.status === 'pending' ? (
                      <span className="badge" style={{ opacity: 0.7 }}>{t('run.build.status.pending')}</span>
                    ) : r.status === 'warn' ? (
                      <span className="badge warn">{t('run.build.status.warn')}</span>
                    ) : (
                      <span className={`badge ${r.status === 'ok' ? 'ok' : 'err'}`}>{r.status === 'ok' ? t('run.build.status.ok') : t('run.build.status.fail')}</span>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'normal', fontSize: 12.5 }}>
                    {r.status === 'fail' ? <span className="b-off">{r.error ?? r.detail}</span> : r.detail}
                    {r.change ? (
                      <div style={{ opacity: 0.75, marginTop: 2 }}>
                        <strong>{t(`run.build.change.${r.change}`)}</strong>{r.appliedDetail ? ` — ${r.appliedDetail}` : ''}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: '8px 12px' }}>
            <span className={`badge ${report.ok ? 'ok' : 'err'}`}>{report.ok ? t('run.build.verified') : t('run.build.verifyFailed')}</span>
          </div>
        </div>
      ) : null}
      </>
      ) : null}

      {showRun ? (
      <>
      <div className="section-title">
        {t('run.title')}
        {/* Developer mode ('all') keeps the combined run+assessment PDF. Simple mode's
            Run phase gets a Run-ONLY "Results Report" — exactly what's on screen. */}
        {phase === 'all' ? (
          <button
            className="btn ghost"
            style={{ marginLeft: 'auto' }}
            onClick={downloadPdf}
            disabled={!runComplete || pdfBusy}
            title={runComplete ? t('run.pdf.downloadTitle') : t('run.pdf.runFirst')}
          >
            {pdfBusy ? <span className="spin" /> : t('run.pdf.download')}
          </button>
        ) : phase === 'run' ? (
          <button
            className="btn ghost"
            style={{ marginLeft: 'auto' }}
            onClick={downloadRunResultsPdf}
            disabled={!runComplete || pdfBusy || !system}
            title={runComplete ? t('run.pdf.downloadResultsTitle') : t('run.pdf.runFirst')}
          >
            {pdfBusy ? <span className="spin" /> : t('run.pdf.downloadResults')}
          </button>
        ) : null}
      </div>
      {/* In-progress marker: shown to a returning user while the run is still going. */}
      {activity?.kind === 'running' && !runningNow ? (
        <div className="hint" style={{ marginTop: 2, marginBottom: 4, color: 'var(--warn, #b7791f)' }}>
          <span className="spin" style={{ marginRight: 6 }} />
          {t('run.inProgressElsewhere', { ago: timeAgo(activity.startedAt, t) })}
          {activity.runId ? (
            <>
              {' · '}
              <button type="button" className="btn-ghost" onClick={() => void attachToRun(activity.runId!)} disabled={runningNow}>
                {t('run.watchFinish')}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {/* An interrupted run (recovered after a mid-run restart) is legible, not lost:
          the completed steps are preserved above; a re-run continues the work. */}
      {/* A2: a run PARKED on held writes — the decision in Governance resumes it; watch it finish here. */}
      {run?.parked && run.heldApprovals && run.heldApprovals.length > 0 && !runningNow ? (
        <div className="hint" style={{ marginTop: 2, marginBottom: 4, color: 'var(--warn, #b7791f)' }}>
          {t.rich('run.parked', {
            calls: () => run.heldApprovals!.map((h, i) => (
              <span key={h.approvalId}>
                {i > 0 ? ', ' : ''}<code>{h.tool}</code> ({h.node}){' '}
                <button
                  type="button"
                  className="btn-ghost"
                  title={t('run.withdrawTitle')}
                  onClick={() => void withdrawHeld(h.approvalId)}
                  disabled={runningNow || withdrawing !== ''}
                >
                  {withdrawing === h.approvalId ? t('run.withdrawing') : t('run.withdraw')}
                </button>
              </span>
            )),
            link: (c) => <a href={`/governance?focus=${encodeURIComponent(run.heldApprovals![0].approvalId)}`}>{c}</a>,
          })}{' '}
          {run.runId ? (
            <button type="button" className="btn-ghost" onClick={() => void attachToRun(run.runId!)} disabled={runningNow}>
              {t('run.watchFinish')}
            </button>
          ) : null}
        </div>
      ) : null}
      {/* A run that ended because an AGENT FAILED says so, where and why — it is not "done". */}
      {run?.failed && !runningNow ? (
        <div className="hint" role="alert" style={{ marginTop: 2, marginBottom: 4, color: 'var(--err, #c53030)' }}>
          {run.failedNode
            ? t.rich('run.failedAt', { node: run.failedNode, reason: run.failureReason ?? t('run.failedReasonFallback'), code: (c) => <code>{c}</code> })
            : t('run.failedPlain', { reason: run.failureReason ?? t('run.failedReasonFallback') })}
        </div>
      ) : null}
      {run?.interrupted && view.source === 'stored' && !runningNow && !run.parked ? (
        <div className="hint" style={{ marginTop: 2, marginBottom: 4, color: 'var(--warn, #b7791f)' }}>
          {run.runId && run.checkpointer === 'postgres' ? (
            <>
              {t.rich('run.interrupted.resumable', {
                ago: timeAgo(view.at ?? Date.now(), t),
                resume: (c) => (
                  <button type="button" className="btn-ghost" onClick={() => void doRun(false, run.runId)} disabled={runningNow}>
                    {c}
                  </button>
                ),
              })}
            </>
          ) : run.runId ? (
            <>{t('run.interrupted.memory', { ago: timeAgo(view.at ?? Date.now(), t) })}</>
          ) : (
            <>{t('run.interrupted.restart', { ago: timeAgo(view.at ?? Date.now(), t) })}</>
          )}
        </div>
      ) : null}
      {/* Engine notes (review M1): compile warnings (e.g. a guard over a channel nothing sets) and
          where this run's checkpoints live — one calm amber line, never silent. */}
      {run && !runningNow && ((run.warnings && run.warnings.length > 0) || run.checkpointer) ? (
        <div className="hint" style={{ marginTop: 2, marginBottom: 4, color: 'var(--warn, #b7791f)' }}>
          {run.checkpointer ? <>{run.checkpointer === 'postgres' ? t('run.checkpointsPostgres') : t('run.checkpointsMemory')}{run.warnings && run.warnings.length > 0 ? ' · ' : ''}</> : null}
          {run.warnings && run.warnings.length > 0 ? <>{t('run.warnings', { count: run.warnings.length, list: run.warnings.join(' · ') })}</> : null}
        </div>
      ) : null}
      <p className="hint" style={{ marginTop: 0 }}>
        {t('run.governedHint')}
      </p>
      {/* Which definition a run uses. Edits in the builder save as they are made, and a run
          reads the saved definition when it starts — so a changed grant, instruction or output
          needs no rebuild, and nothing here should suggest it does. */}
      <p className="hint" style={{ marginTop: 0 }}>
        {t('run.definitionHint')}
      </p>
      {/* Primary affordance: one click runs the task DEFINED in Define. The server
          fills a real, purpose-derived default when the prompt is empty — no need to
          re-type the task. An optional collapsible adds a one-off input for this run. */}
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn lg" onClick={() => doRun(false)} disabled={runningNow || !canRun}>
          {runningNow ? <span className="spin" /> : t('run.runButton')}
        </button>
        {running ? (
          <button className="btn ghost sm" onClick={() => doRun(true)} disabled={runningNow || !canEdit}>{t('run.stop')}</button>
        ) : null}
        {!showInput ? (
          <button className="btn ghost sm" onClick={() => setShowInput(true)} disabled={runningNow}>
            {t('run.addInput')}
          </button>
        ) : null}
      </div>
      {showInput ? (
        <div style={{ marginTop: 8 }}>
          <label className="hint" style={{ fontWeight: 600, display: 'block', marginBottom: 4 }} htmlFor="run-task">
            {t('run.inputLabel')}
          </label>
          <input
            id="run-task"
            type="text"
            value={prompt}
            autoFocus
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') doRun(false); }}
            placeholder={t('run.inputPlaceholder')}
            style={{ width: '100%' }}
          />
        </div>
      ) : null}
      {runErr ? <div className="error" style={{ marginTop: 10 }}>{runErr}</div> : null}
      {keyNotice && !showBuild && showRun ? (
        <div className="hint" role="status" style={{ marginTop: 10, color: 'var(--warn, #b7791f)' }}>
          <strong>{builtAt ? t('run.build.rebuildNeeded') : t('run.build.buildNeeded')}</strong> {keyNotice}
        </div>
      ) : null}

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
                commentary={live ? liveLine(live, t) : t('run.runningTeam')}
              />
              <p className="hint" style={{ marginTop: 6 }}>{t('run.runningHint')}</p>
            </>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="spin" />
              <strong>{live ? liveLine(live, t) : t('run.runningTeam')}</strong>
            </div>
          )}
        </div>
      ) : null}
      </>
      ) : null}

      {run ? (
        <div className="answer" style={{ marginTop: 12, fontSize: 13 }}>
          {/* WHICH run this is — always, in the Run and the Evaluate half alike: a stored earlier
              run reads "Last run · …", the run just followed here "This run · …", each with its
              start time and short id. Everything below belongs to this run only. */}
          {showRun || showEvaluate ? (
            <div className="hint" data-run-source={view.source ?? undefined} title={run.runId} style={{ marginTop: 0, marginBottom: 6 }}>
              {runLabelParts(view, (ms) => f.dateTime(ms, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))
                .map((p) => t(p.key, p.args))
                .join(' · ')}
            </div>
          ) : null}
          {showRun ? (
          <>
          {/* One-line run summary — a student sees instantly whether it worked and how far
              it got, before any drill-down. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span className={`badge ${run.ok ? 'ok' : run.failed ? 'err' : 'warn'}`}>{run.ok ? '✓' : run.failed ? '✗' : '!'}</span>
            <strong style={{ fontSize: 13 }}>{runSummary(run, t)}</strong>
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
            <div className="section-title" style={{ marginTop: 0 }}>{run.nodes && run.nodes.length > 0 ? t('run.result.finalOutput') : t('run.result.runOutput')}</div>
            {run.output ? (
              <Markdown>{run.output}</Markdown>
            ) : (
              <p className="hint" style={{ margin: 0 }}>{t('run.result.noText')}</p>
            )}
          </div>

          {/* WRITE OUTCOMES — the honest "what actually changed" banner, prominent right
              under the final output: direct My-scope writes (ran without approval, the
              My-direct rule) and any writes held in Governance → Inbox. Counted from the
              real executed steps, never inferred. Silent when the run wrote nothing. */}
          <WriteOutcomeBanner writeSummary={run.writeSummary} />

          {/* DECLARED OUTPUTS — where the engine saved each result, what waits for a domain
              admin, and what was not saved and why; with "Try saving again". */}
          <RunOutputs
            systemId={systemId}
            outputs={run.outputs}
            canSave={canRun}
            running={runningNow}
            onSaved={(outputs, runId) => { dispatchRun({ type: 'patched', runId: runId ?? run.runId, patch: { outputs } }); onStateChange(); }}
          />

          {/* Path, governed-call counts and the raw tool-call table are run DETAIL —
              in Simple mode they belong under Evaluate (mirrored below), so Run stays
              progress + final result. Developer mode ('all') keeps them here, unchanged. */}
          {phase === 'all' ? (
          <>
          {/* i18n-ignore — END is the LangGraph terminal node id, shown as code */}
          <div><strong>{t('run.result.path')}</strong> <span className="mono">{run.path.join(' → ')} → END</span></div>
          <div style={{ marginTop: 6 }}>
            <span className="badge ok">{t('run.result.governedCalls', { count: run.steps.length })}</span>{' '}
            <span className="badge">{t('run.result.traces', { count: run.traces })}</span>{' '}
            {run.held > 0 ? <span className="badge warn">{t('run.result.held', { count: run.held })}</span> : <span className="badge ok">{t('run.result.noApprovals')}</span>}
            {run.mode === 'offline-mock' ? <span className="badge" style={{ marginLeft: 6 }}>{t('run.result.offlineMock')}</span> : null}
          </div>

          {/* Step-by-step: the plan→act tool calls the agent actually made. */}
          {run.steps.length > 0 ? (
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>#</th><th>{t('run.result.agent')}</th><th>{t('run.result.toolCall')}</th><th>{t('run.result.decision')}</th></tr></thead>
                <tbody>
                  {run.steps.map((s, i) => (
                    <tr key={`${s.node}-${s.tool}-${i}`}>
                      <td className="mono">{i + 1}</td>
                      <td className="mono">{s.node}</td>
                      <td className="mono">{s.tool}</td>
                      <td>
                        <span className={`badge ${EFFECT_BADGE[s.effect] ?? ''}`}>{s.effect}</span>
                        {s.ran === false ? <span className="b-off" style={{ marginLeft: 6 }}>{t('run.result.notRun')}</span> : null}
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
              {/* i18n-ignore — END is the LangGraph terminal node id, shown as code */}
              <div><strong>{t('run.result.path')}</strong> <span className="mono">{run.path.join(' → ')} → END</span></div>
              <div style={{ marginTop: 6, marginBottom: 4 }}>
                <span className="badge ok">{t('run.result.governedCalls', { count: run.steps.length })}</span>{' '}
                <span className="badge">{t('run.result.traces', { count: run.traces })}</span>{' '}
                {run.held > 0 ? <span className="badge warn">{t('run.result.held', { count: run.held })}</span> : <span className="badge ok">{t('run.result.noApprovals')}</span>}
                {run.mode === 'offline-mock' ? <span className="badge" style={{ marginLeft: 6 }}>{t('run.result.offlineMock')}</span> : null}
              </div>
              {run.steps.length > 0 ? (
                <div className="table-wrap" style={{ marginTop: 10, marginBottom: 4 }}>
                  <table>
                    <thead><tr><th>#</th><th>{t('run.result.agent')}</th><th>{t('run.result.toolCall')}</th><th>{t('run.result.decision')}</th></tr></thead>
                    <tbody>
                      {run.steps.map((s, i) => (
                        <tr key={`ev-${s.node}-${s.tool}-${i}`}>
                          <td className="mono">{i + 1}</td>
                          <td className="mono">{s.node}</td>
                          <td className="mono">{s.tool}</td>
                          <td>
                            <span className={`badge ${EFFECT_BADGE[s.effect] ?? ''}`}>{s.effect}</span>
                            {s.ran === false ? <span className="b-off" style={{ marginLeft: 6 }}>{t('run.result.notRun')}</span> : null}
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
            const tot = diag.totals;
            const showMetrics = diag.traceMetricsAvailable;
            return (
              <div style={{ marginTop: 12 }}>
                <div className="section-title" style={{ marginTop: 0 }}>{t('diagnostics.title')}</div>
                <p className="hint" style={{ marginTop: 0 }}>
                  {showMetrics ? t('diagnostics.hintMetrics') : t('diagnostics.hintNoMetrics')}
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t('diagnostics.col.agent')}</th>
                        <th>{t('diagnostics.col.modelTier')}</th>
                        <th>{t('diagnostics.col.calls')}</th>
                        <th>{t('diagnostics.col.decision')}</th>
                        {showMetrics ? <><th>{t('diagnostics.col.tokens')}</th><th>{t('diagnostics.col.latency')}</th><th>{t('diagnostics.col.cost')}</th></> : null}
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
                            <span className={`badge ${NODE_STATUS_BADGE[r.decision]}`}>{t(`diagnostics.status.${r.decision}`)}</span>
                            {r.denied > 0 ? <span className="badge warn" style={{ marginLeft: 4 }}>{t('diagnostics.denied', { count: r.denied })}</span> : null}
                            {r.errors > 0 ? <span className="badge err" style={{ marginLeft: 4 }}>{t('diagnostics.errors', { count: r.errors })}</span> : null}
                          </td>
                          {showMetrics ? (
                            <>
                              <td className="mono">{r.tokens != null ? f.number(Math.round(r.tokens)) : '—'}</td>
                              <td className="mono">{r.latencyMs != null ? t('diagnostics.ms', { ms: Math.round(r.latencyMs) }) : '—'}</td>
                              <td className="mono">{r.costUsd != null ? usd(r.costUsd) : '—'}</td>
                            </>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td className="mono" style={{ fontWeight: 600 }}>{t('diagnostics.total')}</td>
                        <td className="hint">{t('diagnostics.agents', { count: tot.nodes })}</td>
                        <td className="mono" style={{ fontWeight: 600 }}>{tot.calls}</td>
                        <td className="hint">{t('diagnostics.totalsDecision', { denied: tot.denied, errors: tot.errors })}</td>
                        {showMetrics ? (
                          <>
                            <td className="mono" style={{ fontWeight: 600 }}>{tot.tokens != null ? f.number(Math.round(tot.tokens)) : '—'}</td>
                            <td className="mono" style={{ fontWeight: 600 }}>{tot.latencyMs != null ? t('diagnostics.ms', { ms: Math.round(tot.latencyMs) }) : '—'}</td>
                            <td className="mono" style={{ fontWeight: 600 }}>{tot.costUsd != null ? usd(tot.costUsd) : '—'}</td>
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
              <>{t.rich('diagnostics.traceFull', { link: (c) => <a href={run.traceUrl} target="_blank" rel="noreferrer">{c}</a> })}</>
            ) : (
              <>{t('diagnostics.traceUnavailable')}</>
            )}
          </div>
          </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
