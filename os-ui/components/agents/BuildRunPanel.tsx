/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';

/**
 * Build = execute + verify (Task 4) and Run (Task 7). Build runs the 5 adapters
 * (forgejo / opa / litellm / langgraph / langfuse) apply→verify and shows an
 * inline ✓/✗ row per tool with the exact error — a row is ✓ ONLY when BOTH apply
 * AND verify pass, so Build can never report success without a real check. Run
 * fires a test invocation through the governed gateway (every tool call OPA-checked
 * + Langfuse-traced); any write that needs approval is held in the Governance queue.
 */

type BuildRow = { tool: string; applied: boolean; verified: boolean; status: 'ok' | 'fail'; detail: string; error?: string };
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
  output?: string;
  mode?: 'live' | 'offline-mock';
  traceStoreAvailable?: boolean;
  traceUrl?: string;
};

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
type NodeStatus = 'ok' | 'failed' | 'denied';
/** A per-node reveal for the multi-agent run: status + what it concluded + its tool calls. */
type RunNode = {
  node: string;
  model?: string;
  status: NodeStatus;
  error?: string;
  finalText?: string;
  steps: { tool: string; isError?: boolean; summary?: string }[];
};
type RunReport = {
  running: boolean;
  ok: boolean;
  path: string[];
  traces: number;
  held: number;
  steps: RunStep[];
  nodes?: RunNode[];
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
  finalText?: string;
  steps?: { tool: string; isError?: boolean; summary?: string }[];
};
type RawRun = Partial<RunReport> & { team?: boolean; finalText?: string; nodes?: TeamNode[] };

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
  // Preserve the per-node reveal (status / finalText / step summaries) when present.
  const nodes: RunNode[] | undefined = body.nodes?.map((n) => ({
    node: n.node,
    model: n.model,
    status: n.status ?? 'ok',
    error: n.error,
    finalText: n.finalText,
    steps: (n.steps ?? []).map((s) => ({ tool: s.tool, isError: s.isError, summary: s.summary })),
  }));
  const rawOut = body.output ?? body.finalText;
  return {
    running: body.running ?? false,
    ok: body.ok ?? true,
    path: Array.isArray(body.path) ? body.path : [],
    traces: body.traces ?? 0,
    held: body.held ?? 0,
    steps,
    nodes,
    output: typeof rawOut === 'string' ? rawOut : rawOut ? JSON.stringify(rawOut) : undefined,
    mode: body.mode,
    traceStoreAvailable: body.traceStoreAvailable,
    traceUrl: body.traceUrl,
  };
}

const EFFECT_BADGE: Record<string, string> = { allow: 'ok', deny: 'err', requires_approval: 'warn' };
const NODE_STATUS_BADGE: Record<NodeStatus, string> = { ok: 'ok', denied: 'warn', failed: 'err' };
const NODE_STATUS_LABEL: Record<NodeStatus, string> = { ok: '✓ ok', denied: 'tool denied', failed: '✗ failed' };

export default function BuildRunPanel({
  systemId,
  running,
  canEdit,
  lastBuild,
  activity,
  lastRun,
  nodePath,
  onStateChange,
}: {
  systemId: string;
  running: boolean;
  canEdit: boolean;
  lastBuild?: LastBuild | null;
  activity?: ActivityMarker | null;
  lastRun?: LastRun | null;
  /** The team's node path — shown as an immediate in-progress affordance on Run. */
  nodePath?: string[];
  onStateChange: () => void;
}) {
  const [building, setBuilding] = useState(false);
  // Seed from server-persisted lastBuild so the panel survives tab-switches.
  const [report, setReport] = useState<BuildReport | null>(lastBuild ?? null);
  // Track the timestamp of the currently displayed report (null = never built).
  const [builtAt, setBuiltAt] = useState<number | null>(lastBuild?.at ?? null);
  const [buildErr, setBuildErr] = useState('');

  const [prompt, setPrompt] = useState('Test invocation');
  const [runningNow, setRunningNow] = useState(false);
  // Seed from server-persisted lastRun so the panel survives tab-switches.
  const [run, setRun] = useState<RunReport | null>(lastRun ?? null);
  const [runErr, setRunErr] = useState('');

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

  const doRun = async (stop = false) => {
    setRunningNow(true);
    setRunErr('');
    // Immediately clear the prior result so the in-progress state is unambiguous —
    // the student sees "running the team…" the instant they press Run, never a stale
    // report or a silent spinner. (A stop press keeps the last result visible.)
    if (!stop) setRun(null);
    try {
      const res = await fetch(`/api/agents/systems/${systemId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(stop ? { stop: true } : { prompt }),
      });
      const body = await res.json();
      if (!res.ok) setRunErr(body.error ?? 'Run failed');
      else if (!stop) setRun(normalizeRun(body as RawRun));
      onStateChange();
    } catch (e) {
      setRunErr((e as Error).message);
    } finally {
      setRunningNow(false);
    }
  };

  return (
    <div className="buildrun-panel">
      <div className="section-title" style={{ marginTop: 4 }}>
        Build — execute + verify
        <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={doBuild} disabled={building || !canEdit}>
          {building ? <span className="spin" /> : 'Build'}
        </button>
      </div>
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
                  : `✗ ${report.rows.filter((r) => r.status !== 'ok').length} failing`}
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
                    <span className={`badge ${r.status === 'ok' ? 'ok' : 'err'}`}>{r.status === 'ok' ? '✓ ok' : '✗ fail'}</span>
                  </td>
                  <td style={{ whiteSpace: 'normal', fontSize: 12.5 }}>
                    {r.status === 'ok' ? r.detail : <span className="b-off">{r.error ?? r.detail}</span>}
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

      <div className="section-title">Run</div>
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
        A test invocation walks the graph from the entrypoint; every tool call is forced through the
        governed gateway (LiteLLM → OPA → Langfuse). Approvals land in Governance.
      </p>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="text" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="prompt for the test invocation" style={{ flex: 1, minWidth: 220 }} />
        <button className="btn sm" onClick={() => doRun(false)} disabled={runningNow || !canEdit}>
          {runningNow ? <span className="spin" /> : 'Run'}
        </button>
        {running ? (
          <button className="btn ghost sm" onClick={() => doRun(true)} disabled={runningNow || !canEdit}>Stop</button>
        ) : null}
      </div>
      {runErr ? <div className="error" style={{ marginTop: 10 }}>{runErr}</div> : null}

      {/* FIX 1 — immediate in-progress: the instant Run is pressed, show an animated
          indicator + the team's node path so it's obvious the run started and will
          report back. Replaced by the per-node reveal the moment results arrive. */}
      {runningNow && !run ? (
        <div className="answer running-now" style={{ marginTop: 12, fontSize: 13 }} aria-live="polite">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="spin" />
            <strong>Running the team…</strong>
          </div>
          {nodePath && nodePath.length > 0 ? (
            <div className="mono" style={{ marginTop: 6, opacity: 0.75 }}>
              {nodePath.join(' → ')} → END
            </div>
          ) : null}
          <p className="hint" style={{ marginTop: 6 }}>Each agent runs in turn, handing its results to the next. This may take a moment.</p>
        </div>
      ) : null}

      {run ? (
        <div className="answer" style={{ marginTop: 12, fontSize: 13 }}>
          {/* FIX 2 — node-by-node reveal (multi-agent runs): each agent as a card with
              its status, what it concluded, and the tool calls it made (with a short
              result summary + denial/error flags). One scroll, Apple-clean. */}
          {run.nodes && run.nodes.length > 0 ? (
            <>
              <div className="section-title" style={{ marginTop: 0 }}>The team, step by step</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                {run.nodes.map((n, i) => (
                  <div key={`${n.node}-${i}`} className="node-card" style={{ border: '1px solid var(--border, #e5e5e5)', borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="mono" style={{ fontWeight: 600 }}>{n.node}</span>
                      <span className={`badge ${NODE_STATUS_BADGE[n.status]}`}>{NODE_STATUS_LABEL[n.status]}</span>
                      {n.model ? <span className="hint mono" style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.7 }}>{n.model}</span> : null}
                    </div>
                    {n.error ? <div className="b-off" style={{ marginTop: 6 }}>{n.error}</div> : null}
                    {n.finalText ? (
                      <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', opacity: 0.92 }}>{n.finalText}</p>
                    ) : null}
                    {n.steps.length > 0 ? (
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {n.steps.map((s, j) => (
                          <div key={`${s.tool}-${j}`} style={{ fontSize: 12.5 }}>
                            <span className={`badge ${s.isError ? 'err' : 'ok'}`} style={{ marginRight: 6 }}>{s.isError ? 'denied' : 'ok'}</span>
                            <span className="mono">{s.tool}</span>
                            {s.summary ? <span style={{ opacity: 0.7 }}> — {s.summary}</span> : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {/* Final output — always shown, straight from the run (no Langfuse needed).
              For a team run this is clearly delimited as THE result the student wants. */}
          <div className="section-title" style={{ marginTop: 0 }}>{run.nodes && run.nodes.length > 0 ? 'Final output' : 'Run output'}</div>
          <p className="mono" style={{ margin: '2px 0 8px', whiteSpace: 'pre-wrap' }}>
            {run.output || '(the run produced no final text)'}
          </p>

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

          {/* Trace store: honest note when the durable store is down; deep-link when up. */}
          <div className="hint" style={{ marginTop: 8 }}>
            {run.traceStoreAvailable && run.traceUrl ? (
              <>Full trace: <a href={run.traceUrl} target="_blank" rel="noreferrer">open in Langfuse ↗</a></>
            ) : (
              <>Live trace store unavailable — showing the in-run steps above (the durable Langfuse trace may lag or be down).</>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
