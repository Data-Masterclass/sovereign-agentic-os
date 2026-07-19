/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import { CHANNELS, flatMetrics, postJson, slug } from './shared';
import type { AlertResponse, Channel, Comparator, MetricGroups } from './shared';

const COMPARATORS: { key: Comparator; label: string }[] = [
  { key: 'lt', label: '<' },
  { key: 'lte', label: '≤' },
  { key: 'gt', label: '>' },
  { key: 'gte', label: '≥' },
];
const CHANNEL_LABEL: Record<Channel, string> = { email: 'Email', slack: 'Slack', in_app: 'In-app' };

type AgentSystemSummary = { id: string; name: string };

/**
 * Alerts — a threshold on a governed metric member. On breach the route NOTIFIES the
 * chosen channels AND, if a governed agent is wired, triggers a Langfuse-traced agent run
 * (event → LangGraph).
 *
 * The live metric value is resolved by the server (via Cube) — no hand-typed demo
 * value. Rules are persisted and can be batch-evaluated via /api/metrics/alerts/run
 * (wire to a CronJob for continuous monitoring).
 *
 * Two ways in: the Metrics surface renders this over the whole `metrics` palette; a metric's
 * DETAIL renders it with `presetMember` locked to that one member ("set an alert on this
 * metric"), so the picker collapses to a fixed label.
 */
export default function Alerts({
  metrics,
  loading,
  presetMember,
}: {
  metrics: MetricGroups | null;
  loading: boolean;
  presetMember?: string;
}) {
  const palette = flatMetrics(metrics);
  const [member, setMember] = useState(presetMember ?? '');
  const [comparator, setComparator] = useState<Comparator>('lt');
  const [threshold, setThreshold] = useState('1000');
  const [notify, setNotify] = useState<Channel[]>(['email']);
  const [agentOn, setAgentOn] = useState(false);
  const [systemId, setSystemId] = useState('');
  const [agent, setAgent] = useState('revenue-watch');
  const [preset, setPreset] = useState('investigate');
  const [result, setResult] = useState<AlertResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Load real agent systems for the system picker
  const [systems, setSystems] = useState<AgentSystemSummary[]>([]);
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/agents/systems', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          const mine: AgentSystemSummary[] = (data.mine ?? []).map((s: { id: string; name: string }) => ({ id: s.id, name: s.name }));
          const domain: AgentSystemSummary[] = (data.domain ?? []).map((s: { id: string; name: string }) => ({ id: s.id, name: s.name }));
          const all = [...mine, ...domain];
          setSystems(all);
          if (all.length > 0 && !systemId) setSystemId(all[0].id);
        }
      } catch { /* non-blocking */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const effectiveMember = presetMember || member || palette[0]?.member || '';

  const toggleChannel = (c: Channel) =>
    setNotify((ns) => (ns.includes(c) ? ns.filter((x) => x !== c) : [...ns, c]));

  const evaluate = async () => {
    setError('');
    setResult(null);
    if (!effectiveMember) return setError('Pick a metric member.');
    if (notify.length === 0) return setError('Choose at least one notification channel.');
    setBusy(true);
    try {
      const rule = {
        id: slug(`${effectiveMember}-${comparator}-${threshold}`) || 'alert',
        member: effectiveMember,
        comparator,
        threshold: Number(threshold),
        notify,
        triggerAgent: agentOn ? { systemId, agent, preset } : undefined,
      };
      // No `value` — the route resolves the live Cube number
      const res = await postJson<AlertResponse & { pending?: boolean; saved?: boolean }>('/api/metrics/alerts', { rule });
      if ((res as { pending?: boolean }).pending) {
        setError('Could not resolve live value — metric may still be syncing (~30 s). Try again shortly.');
        return;
      }
      setResult(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-editor" style={{ marginTop: 18 }}>
      <div className="agent-editor-title">Metric alert</div>
      <p className="hint" style={{ marginTop: 4 }}>
        A threshold on a governed metric member — notifies, and optionally triggers a traced agent run.
        The rule evaluates against the <strong>live Cube metric value</strong> and is saved for
        continuous monitoring (batch-evaluate via the alerts/run endpoint or wire to a CronJob).
      </p>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginTop: 12 }}>
        <label>
          <span className="comp-label">Metric member</span>
          {presetMember ? (
            <div className="mono" style={{ fontSize: 12, paddingTop: 6 }}>{presetMember}</div>
          ) : loading && palette.length === 0 ? (
            <div className="hint">Loading metrics…</div>
          ) : (
            <select value={effectiveMember} onChange={(e) => setMember(e.target.value)} style={{ width: '100%' }}>
              {palette.map((m) => <option key={m.id} value={m.member}>{m.member}</option>)}
            </select>
          )}
        </label>
        <label>
          <span className="comp-label">Comparator</span>
          <select value={comparator} onChange={(e) => setComparator(e.target.value as Comparator)} style={{ width: '100%' }}>
            {COMPARATORS.map((c) => <option key={c.key} value={c.key}>{c.label} ({c.key})</option>)}
          </select>
        </label>
        <label>
          <span className="comp-label">Threshold</span>
          <input type="text" value={threshold} onChange={(e) => setThreshold(e.target.value)} inputMode="decimal" />
        </label>
      </div>

      <label className="comp-label" style={{ marginTop: 14 }}>Notify</label>
      <div className="chk-grid">
        {CHANNELS.map((c) => (
          <label key={c} className="chk">
            <input type="checkbox" checked={notify.includes(c)} onChange={() => toggleChannel(c)} />
            {CHANNEL_LABEL[c]}
          </label>
        ))}
      </div>

      <label className="chk" style={{ marginTop: 12, maxWidth: 320 }}>
        <input type="checkbox" checked={agentOn} onChange={(e) => setAgentOn(e.target.checked)} />
        Trigger a governed agent on breach
      </label>
      {agentOn ? (
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginTop: 10 }}>
          <label>
            <span className="comp-label">System</span>
            {systems.length > 0 ? (
              <select value={systemId} onChange={(e) => setSystemId(e.target.value)} style={{ width: '100%' }}>
                {systems.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            ) : (
              <input type="text" value={systemId} onChange={(e) => setSystemId(e.target.value)} placeholder="system id" />
            )}
          </label>
          <label><span className="comp-label">Agent</span><input type="text" value={agent} onChange={(e) => setAgent(e.target.value)} /></label>
          <label><span className="comp-label">Preset</span><input type="text" value={preset} onChange={(e) => setPreset(e.target.value)} /></label>
        </div>
      ) : null}

      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn" onClick={evaluate} disabled={busy}>
          {busy ? <span className="spin" /> : 'Evaluate alert'}
        </button>
      </div>

      {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}

      {result ? (
        <div className="build-report">
          <div className="row" style={{ alignItems: 'center' }}>
            <span className={`badge ${result.breached ? 'err' : 'ok'}`}>{result.breached ? 'Breached' : 'OK'}</span>
            <span className="muted">value {result.value}</span>
            <span className="hint" style={{ marginLeft: 8 }}>Rule saved — evaluates against live Cube value</span>
          </div>
          {result.breached ? (
            <>
              {result.notifications.map((n, i) => (
                <div key={i} className="build-row ok">
                  <span className="build-tool">{n.channel}</span>
                  <span>{n.message}</span>
                </div>
              ))}
              {result.agentRun ? (
                <div className="build-row ok">
                  <span className="build-tool">agent</span>
                  <span>
                    {result.agentRun.systemId}:{result.agentRun.agent} ({result.agentRun.preset}) — {result.agentRun.reason}
                    {result.traced ? ' · ✓ traced in Langfuse' : ''}
                  </span>
                </div>
              ) : null}
            </>
          ) : (
            <div className="hint" style={{ marginTop: 8 }}>No breach — nothing fired.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
