/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useState } from 'react';
import PageHeader from '@/components/PageHeader';
import ArtifactPanel from '@/components/ArtifactPanel';
import { useApi } from '@/lib/useApi';

type Anno = { name: string; title: string; shortTitle?: string; type?: string };
type Data = {
  cube: string;
  measures: Anno[];
  dimensions: Anno[];
  columns: string[];
  rows: string[][];
  rowCount: number;
};

export default function MetricsPage() {
  const { data, loading, error, reload } = useApi<Data>('/api/metrics');
  const [view, setView] = useState<'workspace' | 'cube'>('workspace');

  return (
    <>
      <PageHeader title="Metrics" crumb="business metrics, defined once — Cube semantic layer" />
      <div className="content">
        <p className="lead">
          One consistent definition of every metric — grain, dimensions, and measures — served
          from the Cube semantic layer to dashboards and agents alike. Author your own metric
          artifacts, or inspect the live <code>daily_revenue</code> cube.
        </p>

        <div className="tabstrip">
          <button className={view === 'workspace' ? 'active' : ''} onClick={() => setView('workspace')}>My metrics</button>
          <button className={view === 'cube' ? 'active' : ''} onClick={() => setView('cube')}>Live Cube</button>
        </div>

        {view === 'workspace' ? (
          <ArtifactPanel
            type="metric"
            createLabel="Create metric"
            specFields={[
              { key: 'measures', label: 'Measures', placeholder: 'DailyRevenue.amount' },
              { key: 'dimensions', label: 'Dimensions', placeholder: 'DailyRevenue.day' },
            ]}
            renderSpec={(a) => {
              const m = String(a.spec?.measures ?? '');
              const d = String(a.spec?.dimensions ?? '');
              return m || d ? (
                <div className="muted mono" style={{ fontSize: 11 }}>
                  {m ? <>measures: {m}<br /></> : null}{d ? <>dimensions: {d}</> : null}
                </div>
              ) : null;
            }}
            intro={
              <p className="hint" style={{ marginTop: 0 }}>
                Define a metric (measures + dimensions) as an artifact. Wiring the artifact into a
                generated Cube model is <strong>scaffolded in v1</strong>; the live Cube below is
                served read-only from the platform model.
              </p>
            }
          />
        ) : (
          <>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="section-title" style={{ margin: 0 }}>Cube · <code>{data?.cube ?? 'daily_revenue'}</code></div>
              <button className="btn ghost" onClick={reload} disabled={loading}>{loading ? <span className="spin" /> : 'Refresh'}</button>
            </div>
            {error ? <div className="error" style={{ marginTop: 16 }}>{error}</div> : null}
            {data ? (
              <>
                <div className="grid" style={{ marginTop: 14 }}>
                  {data.measures.map((m) => (
                    <div className="card" key={m.name}>
                      <h3>Measure</h3>
                      <div className="big">{m.shortTitle ?? m.title}</div>
                      <div className="muted mono" style={{ fontSize: 11.5, marginTop: 4 }}>{m.name}</div>
                      <div className="muted">{m.type ?? 'number'}</div>
                    </div>
                  ))}
                  {data.dimensions.map((d) => (
                    <div className="card" key={d.name}>
                      <h3>Dimension</h3>
                      <div className="big">{d.shortTitle ?? d.title}</div>
                      <div className="muted mono" style={{ fontSize: 11.5, marginTop: 4 }}>{d.name}</div>
                      <div className="muted">{d.type ?? 'string'}</div>
                    </div>
                  ))}
                </div>
                <div className="section-title">Result · {data.rowCount} row{data.rowCount === 1 ? '' : 's'}</div>
                {data.rows.length === 0 ? (
                  <div className="stub-page">Cube returned no rows — materialize <code>analytics.daily_revenue</code> first.</div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead><tr>{data.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                      <tbody>{data.rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
                    </table>
                  </div>
                )}
              </>
            ) : loading ? (
              <div className="stub-page" style={{ marginTop: 16 }}>Loading metrics…</div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
