/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { flatMetrics, postJson, slug, VIZ_TYPES } from './shared';
import type { BuildResponse, ChartSpec, MetricGroups, MetricSummary, VizType } from './shared';

type Mode = 'drag-drop' | 'agent';

/** The Cube view a chart's member belongs to (member = `View.measure`). */
function viewOf(charts: ChartSpec[]): string {
  const m = charts[0]?.metric ?? '';
  return m.includes('.') ? m.slice(0, m.indexOf('.')) : m;
}

/**
 * AGENT mode — propose the SAME chart list a drag-drop user would assemble, best-effort
 * client-side: match governed metrics named in the prompt (fall back to the first few),
 * then a big-number per metric plus a trend line on the first. Both modes POST the same
 * /api/dashboards/build contract, so they converge on one governed spec.
 */
function proposeCharts(prompt: string, metrics: MetricSummary[]): ChartSpec[] {
  const p = prompt.toLowerCase();
  const matched = metrics.filter(
    (m) =>
      p.includes(m.name.toLowerCase()) ||
      p.includes(m.datasetName.toLowerCase()) ||
      p.includes(m.member.slice(0, m.member.indexOf('.')).toLowerCase()),
  );
  const picks = (matched.length ? matched : metrics).slice(0, 4);
  const charts: ChartSpec[] = [];
  picks.forEach((m, i) => {
    charts.push({ name: m.name, vizType: 'big_number_total', metric: m.member });
    if (i === 0) charts.push({ name: `${m.name} trend`, vizType: 'line', metric: m.member });
  });
  return charts;
}

/**
 * New dashboard, DUAL-MODE. Drag-drop: click governed metrics to drop them as chart
 * tiles. Agent: describe the dashboard and it proposes the same chart list. Either way we
 * POST /api/dashboards/build and render the apply→verify build rows (superset / embed /
 * report / alert) with a mode badge.
 */
export default function NewDashboard({
  metrics,
  loading,
  onBuilt,
}: {
  metrics: MetricGroups | null;
  loading: boolean;
  onBuilt: () => void;
}) {
  const [mode, setMode] = useState<Mode>('drag-drop');
  const [name, setName] = useState('');
  const [charts, setCharts] = useState<ChartSpec[]>([]);
  const [prompt, setPrompt] = useState('');
  const [building, setBuilding] = useState(false);
  const [result, setResult] = useState<BuildResponse | null>(null);
  const [error, setError] = useState('');

  const palette = flatMetrics(metrics);
  const view = viewOf(charts);
  // A dashboard binds to ONE Cube view (supersetBundle does SELECT * FROM "<view>"), so
  // charts drawn from two different views would silently drop the other view's members.
  const views = Array.from(new Set(charts.map((c) => (c.metric.includes('.') ? c.metric.slice(0, c.metric.indexOf('.')) : c.metric)).filter(Boolean)));
  const multiView = views.length > 1;

  const addChart = (m: MetricSummary) =>
    setCharts((cs) => [...cs, { name: m.name, vizType: 'big_number_total', metric: m.member }]);
  const updateChart = (i: number, patch: Partial<ChartSpec>) =>
    setCharts((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const removeChart = (i: number) => setCharts((cs) => cs.filter((_, j) => j !== i));

  const propose = () => {
    const next = proposeCharts(prompt, palette);
    setCharts(next);
    if (!name.trim() && next.length) {
      const v = next[0].metric.slice(0, next[0].metric.indexOf('.')) || 'New';
      setName(`${v} overview`);
    }
  };

  const build = async () => {
    setError('');
    setResult(null);
    const trimmed = name.trim();
    if (!trimmed) return setError('Give the dashboard a name.');
    if (charts.length === 0) return setError('Add at least one chart on a governed metric.');
    if (multiView) return setError(`A dashboard binds to one Cube view — these charts span ${views.join(', ')}. Keep charts from a single view.`);
    setBuilding(true);
    try {
      const res = await postJson<BuildResponse>('/api/dashboards/build', {
        id: slug(trimmed) || 'dashboard',
        name: trimmed,
        view,
        mode,
        charts,
      });
      setResult(res);
      onBuilt();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBuilding(false);
    }
  };

  return (
    <div style={{ marginTop: 18 }}>
      <div className="seg" role="tablist" aria-label="Build mode">
        <button className={mode === 'drag-drop' ? 'on' : ''} onClick={() => setMode('drag-drop')}>Drag-drop</button>
        <button className={mode === 'agent' ? 'on' : ''} onClick={() => setMode('agent')}>Agent</button>
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        Both modes land the <strong>same governed spec</strong> — charts reference metric members defined in the Metrics tab.
      </p>

      <div className="agent-editor" style={{ marginTop: 14 }}>
        <label className="comp-label">Dashboard name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Sales overview"
        />
        <div className="hint" style={{ marginTop: 6 }}>
          Cube view: <code>{view || '—'}</code> · id: <code>{slug(name) || '—'}</code>
        </div>

        {mode === 'agent' ? (
          <div style={{ marginTop: 14 }}>
            <label className="comp-label">Describe the dashboard</label>
            <textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="build me a Sales overview"
            />
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn ghost" onClick={propose} disabled={!prompt.trim() || palette.length === 0}>
                Propose charts
              </button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 14 }}>
            <label className="comp-label">Governed metrics — click to drop a chart tile</label>
            {loading && palette.length === 0 ? (
              <div className="hint">Loading metrics…</div>
            ) : palette.length === 0 ? (
              <div className="hint">No governed metrics yet — define one in the Metrics tab.</div>
            ) : (
              <div className="chip-row" style={{ marginTop: 4 }}>
                {palette.map((m) => (
                  <button
                    key={m.id}
                    className="chip"
                    style={{ cursor: 'pointer' }}
                    onClick={() => addChart(m)}
                    title={`Add ${m.member}`}
                  >
                    {m.name} <span className="mono" style={{ opacity: 0.7 }}>{m.member}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <label className="comp-label" style={{ marginTop: 16 }}>Charts ({charts.length})</label>
        {charts.length === 0 ? (
          <div className="chat-empty">No charts yet — {mode === 'agent' ? 'propose from a prompt' : 'click a metric above'}.</div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {charts.map((c, i) => (
              <div key={`${c.metric}-${i}`} className="golden" style={{ gap: 10 }}>
                <input
                  type="text"
                  value={c.name}
                  onChange={(e) => updateChart(i, { name: e.target.value })}
                  style={{ maxWidth: 200 }}
                />
                <select value={c.vizType} onChange={(e) => updateChart(i, { vizType: e.target.value as VizType })}>
                  {VIZ_TYPES.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <span className="mono muted" style={{ fontSize: 12 }}>{c.metric}</span>
                <button className="chip-x" style={{ marginLeft: 'auto' }} onClick={() => removeChart(i)} aria-label="Remove chart">×</button>
              </div>
            ))}
          </div>
        )}

        {multiView ? (
          <div className="hint" style={{ marginTop: 12, color: 'var(--warn-text, inherit)' }}>
            These charts span more than one Cube view (<strong>{views.join(', ')}</strong>). A dashboard binds to a
            single view — keep charts from one view.
          </div>
        ) : null}

        <div className="row" style={{ marginTop: 16, justifyContent: 'space-between', alignItems: 'center' }}>
          <span className={`badge ${mode === 'agent' ? 'warn' : 'muted'}`}>mode: {mode}</span>
          <button className="btn" onClick={build} disabled={building || charts.length === 0 || !name.trim() || multiView}>
            {building ? <span className="spin" /> : 'Build dashboard'}
          </button>
        </div>

        {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}
      </div>

      {result ? (
        <div className="build-report">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>{result.build.ok ? 'Build succeeded' : 'Build had errors'} — {result.spec.name}</strong>
            <span className={`badge ${result.build.mode === 'live' ? 'ok' : 'muted'}`}>{result.build.mode}</span>
          </div>
          {result.build.rows.map((r) => (
            <div key={r.tool} className={`build-row ${r.status === 'ok' ? 'ok' : 'fail'}`}>
              <span className="build-tool">{r.status === 'ok' ? '✓' : '✗'} {r.tool}</span>
              <span>{r.detail || r.error}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
