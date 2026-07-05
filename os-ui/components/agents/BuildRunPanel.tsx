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
type RunStep = { node: string; tool: string; effect: string; ran?: boolean };
type RunReport = {
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

const EFFECT_BADGE: Record<string, string> = { allow: 'ok', deny: 'err', requires_approval: 'warn' };

export default function BuildRunPanel({
  systemId,
  running,
  canEdit,
  onStateChange,
}: {
  systemId: string;
  running: boolean;
  canEdit: boolean;
  onStateChange: () => void;
}) {
  const [building, setBuilding] = useState(false);
  const [report, setReport] = useState<BuildReport | null>(null);
  const [buildErr, setBuildErr] = useState('');

  const [prompt, setPrompt] = useState('Test invocation');
  const [runningNow, setRunningNow] = useState(false);
  const [run, setRun] = useState<RunReport | null>(null);
  const [runErr, setRunErr] = useState('');

  const doBuild = async () => {
    setBuilding(true);
    setBuildErr('');
    try {
      const res = await fetch(`/api/agents/systems/${systemId}/build`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) setBuildErr(body.error ?? 'Build failed');
      else setReport(body as BuildReport);
    } catch (e) {
      setBuildErr((e as Error).message);
    } finally {
      setBuilding(false);
    }
  };

  const doRun = async (stop = false) => {
    setRunningNow(true);
    setRunErr('');
    try {
      const res = await fetch(`/api/agents/systems/${systemId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(stop ? { stop: true } : { prompt }),
      });
      const body = await res.json();
      if (!res.ok) setRunErr(body.error ?? 'Run failed');
      else if (!stop) setRun(body as RunReport);
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
      {run ? (
        <div className="answer" style={{ marginTop: 12, fontSize: 13 }}>
          {/* Final output — always shown, straight from the run (no Langfuse needed). */}
          <div className="section-title" style={{ marginTop: 0 }}>Run output</div>
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
