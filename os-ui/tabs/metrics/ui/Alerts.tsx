/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Metric alerts panel — set a threshold rule on a governed metric member
 * USER STORY: As a metric owner I want to be told when a metric crosses a threshold so that I
 *             can act before the number drifts too far.
 * ARCHITECTURE:
 *   - Client component rendered by `MetricBuilder` (metric View), optionally with
 *     `presetMember` locked to one member.
 *   - POSTs the rule to `/api/metrics/alerts`, which resolves the live value server-side,
 *     persists the rule and delivers an in-app notification; lists agents from
 *     `/api/agents/systems` for the optional agent hook.
 *   - The optional agent hook records a governed `alert_trigger` trace; it does not start an
 *     agent run.
 */
'use client';

import { useEffect, useState } from 'react';
import { useFormat, useTranslations } from '@core/i18n/client';
import { flatMetrics, postJson, slug } from '@tabs/metrics/ui/shared';
import type { AlertResponse, Comparator, MetricGroups } from '@tabs/metrics/ui/shared';

const COMPARATORS: { key: Comparator; label: string }[] = [
  { key: 'lt', label: '<' },
  { key: 'lte', label: '≤' },
  { key: 'gt', label: '>' },
  { key: 'gte', label: '≥' },
];

type AgentSystemSummary = { id: string; name: string };

/**
 * Alerts — a threshold on a governed metric member. On breach the route NOTIFIES you
 * in-app AND, if a governed agent is wired, triggers a Langfuse-traced agent run
 * (event → LangGraph).
 *
 * The live metric value is resolved by the server (one governed Trino SELECT, as you) — no
 * hand-typed demo value. Rules are persisted and can be batch-evaluated via /api/metrics/alerts/run
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
  const t = useTranslations('metrics');
  const f = useFormat();
  const palette = flatMetrics(metrics);
  const [member, setMember] = useState(presetMember ?? '');
  const [comparator, setComparator] = useState<Comparator>('lt');
  const [threshold, setThreshold] = useState('1000');
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

  const evaluate = async () => {
    setError('');
    setResult(null);
    if (!effectiveMember) return setError(t('alerts.pickMember'));
    setBusy(true);
    try {
      const rule = {
        id: slug(`${effectiveMember}-${comparator}-${threshold}`) || 'alert',
        member: effectiveMember,
        comparator,
        threshold: Number(threshold),
        notify: ['in_app'],
        triggerAgent: agentOn ? { systemId, agent, preset } : undefined,
      };
      // No `value` — the route resolves the live number through the governed metric read path
      const res = await postJson<AlertResponse & { pending?: boolean; saved?: boolean }>('/api/metrics/alerts', { rule }, (status) => t('requestFailed', { status: String(status) }));
      if ((res as { pending?: boolean }).pending) {
        setError(t('alerts.pending'));
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
      <div className="agent-editor-title">{t('alerts.title')}</div>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginTop: 12 }}>
        <label>
          <span className="comp-label">{t('alerts.member')}</span>
          {presetMember ? (
            <div className="mono" style={{ fontSize: 12, paddingTop: 6 }}>{presetMember}</div>
          ) : loading && palette.length === 0 ? (
            <div className="hint">{t('alerts.loadingMetrics')}</div>
          ) : (
            <select value={effectiveMember} onChange={(e) => setMember(e.target.value)} style={{ width: '100%' }}>
              {palette.map((m) => <option key={m.id} value={m.member}>{m.member}</option>)}
            </select>
          )}
        </label>
        <label>
          <span className="comp-label">{t('alerts.comparator')}</span>
          <select value={comparator} onChange={(e) => setComparator(e.target.value as Comparator)} style={{ width: '100%' }}>
            {COMPARATORS.map((c) => <option key={c.key} value={c.key}>{c.label} ({c.key})</option>)}
          </select>
        </label>
        <label>
          <span className="comp-label">{t('alerts.threshold')}</span>
          <input type="text" value={threshold} onChange={(e) => setThreshold(e.target.value)} inputMode="decimal" />
        </label>
      </div>

      <p className="hint" style={{ marginTop: 14 }}>{t('alerts.notifyHint')}</p>

      <label className="chk" style={{ marginTop: 12, maxWidth: 320 }}>
        <input type="checkbox" checked={agentOn} onChange={(e) => setAgentOn(e.target.checked)} />
        {t('alerts.triggerAgent')}
      </label>
      {agentOn ? (
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginTop: 10 }}>
          <label>
            <span className="comp-label">{t('alerts.system')}</span>
            {systems.length > 0 ? (
              <select value={systemId} onChange={(e) => setSystemId(e.target.value)} style={{ width: '100%' }}>
                {systems.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            ) : (
              <input type="text" value={systemId} onChange={(e) => setSystemId(e.target.value)} placeholder={t('alerts.systemIdPlaceholder')} />
            )}
          </label>
          <label><span className="comp-label">{t('alerts.agent')}</span><input type="text" value={agent} onChange={(e) => setAgent(e.target.value)} /></label>
          <label><span className="comp-label">{t('alerts.preset')}</span><input type="text" value={preset} onChange={(e) => setPreset(e.target.value)} /></label>
        </div>
      ) : null}

      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn" onClick={evaluate} disabled={busy}>
          {busy ? <span className="spin" /> : t('alerts.evaluate')}
        </button>
      </div>

      {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}

      {result ? (
        <div className="build-report">
          <div className="row" style={{ alignItems: 'center' }}>
            <span className={`badge ${result.breached ? 'err' : 'ok'}`}>{result.breached ? t('alerts.breached') : t('alerts.ok')}</span>
            <span className="muted">{t('alerts.value', { value: f.number(result.value, { useGrouping: false, maximumFractionDigits: 20 }) })}</span>
            <span className="hint" style={{ marginLeft: 8 }}>{t('alerts.ruleSaved')}</span>
          </div>
          {result.breached ? (
            <>
              {result.notifications.map((n, i) => (
                <div key={i} className="build-row ok">
                  <span className="build-tool">{t('alerts.inApp')}</span>
                  <span>{n.message}</span>
                </div>
              ))}
              {result.agentRun ? (
                <div className="build-row ok">
                  <span className="build-tool">{t('alerts.agentRow')}</span>
                  <span>
                    {result.agentRun.systemId}:{result.agentRun.agent} ({result.agentRun.preset}) — {result.agentRun.reason}
                    {result.traced ? ` · ${t('alerts.traced')}` : ''}
                  </span>
                </div>
              ) : null}
            </>
          ) : (
            <div className="hint" style={{ marginTop: 8 }}>{t('alerts.noBreach')}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
