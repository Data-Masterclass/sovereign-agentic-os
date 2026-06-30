/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

type ColumnDoc = { name: string; description: string };
type Measure = { name: string; type: string; sql: string };
type BuildRow = { tool: string; status: 'ok' | 'fail'; detail: string; error?: string };
type Build = { ok: boolean; rows: BuildRow[]; skipped: string[]; mode: 'live' | 'offline-mock' };

const MEASURE_TYPES = ['sum', 'count', 'count_distinct', 'avg', 'min', 'max'] as const;

/** The ✓/✗ Build rows + the honest live/offline-mock mode (shared by metric+dashboard). */
function BuildRows({ build }: { build: Build }) {
  return (
    <div className="build-report">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{build.ok ? '✓ Build passed' : '✗ Build failed'}</strong>
        <span className={`badge ${build.mode === 'live' ? 'ok' : 'muted'}`}>{build.mode}</span>
      </div>
      {build.rows.map((r) => (
        <div key={r.tool} className={`build-row ${r.status}`}>
          <span className="build-tool">{r.status === 'ok' ? '✓' : '✗'} {r.tool}</span>
          <span className="muted" style={{ fontSize: 12 }}>{r.error ?? r.detail}</span>
        </div>
      ))}
      {build.skipped.length ? <div className="hint" style={{ marginTop: 4 }}>not wired yet: {build.skipped.join(', ')}</div> : null}
    </div>
  );
}

/**
 * Metrics + dashboards on the governed Gold version (data-ui-ux.md §"Define a metric").
 * The user names a measure; cube_dbt scaffolds the cube from the Gold model. Building
 * runs the real Cube/Superset adapters (apply→verify) — live when reachable, honest
 * offline-mock otherwise.
 */
export default function MetricsPanel({ datasetId }: { datasetId: string }) {
  const [measures, setMeasures] = useState<Measure[]>([]);
  const [columns, setColumns] = useState<ColumnDoc[]>([]);
  const [cube, setCube] = useState('');
  const [showCube, setShowCube] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [build, setBuild] = useState<Build | null>(null);
  const [dashBuild, setDashBuild] = useState<Build | null>(null);

  // define-a-metric form
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('sum');
  const [column, setColumn] = useState('');

  const load = useCallback(async () => {
    const res = await fetch(`/api/data/datasets/${datasetId}/metric`, { cache: 'no-store' });
    const data = await res.json();
    if (res.ok) { setMeasures(data.measures ?? []); setColumns(data.columns ?? []); setCube(data.cube ?? ''); }
  }, [datasetId]);
  useEffect(() => { load(); }, [load]);

  const define = useCallback(async () => {
    setErr(''); setBusy('metric'); setBuild(null);
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/metric`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), type, sql: type === 'count' ? '' : column }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Could not define metric'); return; }
      setMeasures(data.dataset.measures ?? []); setCube(data.cube ?? ''); setBuild(data.build);
      setName(''); setColumn('');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }, [datasetId, name, type, column]);

  const buildDashboard = useCallback(async () => {
    setErr(''); setBusy('dash'); setDashBuild(null);
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/dashboard`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Could not build dashboard'); return; }
      setDashBuild(data.build);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }, [datasetId]);

  return (
    <div className="guided-panel">
      <p className="muted" style={{ marginTop: 0 }}>
        Define a metric on the harmonized Gold table — pick what to measure; the dimensions come from
        the model automatically. The number becomes the single definition dashboards and the agent both use.
      </p>

      {measures.length ? (
        <div className="chip-row" style={{ marginBottom: 10 }}>
          {measures.map((m) => <span key={m.name} className="chip">{m.name} · {m.type}{m.sql ? `(${m.sql})` : ''}</span>)}
        </div>
      ) : null}

      {measures.length ? (
        <p className="hint" style={{ marginTop: 0 }}>
          <Link href="/metrics" style={{ color: 'var(--gold-text)' }}>Explore &amp; govern this metric in the Metrics tab →</Link>
        </p>
      ) : null}

      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input placeholder="measure name (e.g. revenue)" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 200 }} />
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {MEASURE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {type !== 'count' ? (
          <select value={column} onChange={(e) => setColumn(e.target.value)}>
            <option value="">column…</option>
            {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
        ) : null}
        <button className="btn" onClick={define} disabled={busy !== '' || !name.trim() || (type !== 'count' && !column)}>
          {busy === 'metric' ? <span className="spin" /> : 'Define metric'}
        </button>
      </div>

      {cube ? (
        <>
          <button className={`btn ghost sm${showCube ? ' on' : ''}`} style={{ marginTop: 10 }} onClick={() => setShowCube((v) => !v)}>
            {showCube ? 'Hide the Cube model' : '‹ › Show the Cube model'}
          </button>
          {showCube ? <pre className="codeblock" style={{ marginTop: 8 }}>{cube}</pre> : null}
        </>
      ) : null}

      {err ? <div className="error" style={{ marginTop: 12 }}>{err}</div> : null}
      {build ? <BuildRows build={build} /> : null}

      {measures.length ? (
        <div style={{ marginTop: 16 }}>
          <div className="section-title" style={{ marginTop: 0 }}>Dashboard</div>
          <p className="hint" style={{ marginTop: 0 }}>
            Build a Superset dashboard on the Cube view, then open it in <Link href="/dashboards">Dashboards</Link>.
          </p>
          <button className="btn" onClick={buildDashboard} disabled={busy !== ''}>
            {busy === 'dash' ? <span className="spin" /> : 'Build a dashboard'}
          </button>
          {dashBuild ? <BuildRows build={dashBuild} /> : null}
        </div>
      ) : null}
    </div>
  );
}
