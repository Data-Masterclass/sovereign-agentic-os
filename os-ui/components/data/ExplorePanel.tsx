/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

type Layer = 'bronze' | 'silver' | 'gold';

type ColumnProfile = {
  name: string;
  type: string;
  kind: 'numeric' | 'temporal' | 'boolean' | 'string' | 'other';
  nulls: number;
  nullPct: number;
  distinct: number;
  min: string | null;
  max: string | null;
  top: { value: string; count: number }[];
};

type Profile = {
  available: boolean;
  reason?: string;
  layer?: Layer;
  fqn?: string;
  cached?: boolean;
  rowCount?: number;
  columns?: ColumnProfile[];
  preview?: { columns: string[]; rows: string[][] };
  generatedAt?: string;
};

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** A whisper-quiet null-density bar: empty when a column is complete, warming only
 *  as gaps grow — so a dirty column shows itself without shouting. */
function NullBar({ pct }: { pct: number }) {
  const w = Math.max(0, Math.min(1, pct)) * 100;
  const warm = pct >= 0.2;
  return (
    <div title={`${(pct * 100).toFixed(pct > 0 && pct < 0.01 ? 2 : 0)}% empty`}
      style={{ position: 'relative', height: 5, borderRadius: 3, background: 'var(--panel-2)', overflow: 'hidden', minWidth: 46 }}>
      <div style={{
        position: 'absolute', inset: 0, width: `${w}%`, borderRadius: 3,
        background: w === 0 ? 'transparent' : warm ? 'var(--gold)' : 'var(--teal)',
        opacity: warm ? 0.85 : 0.55, transition: 'width .35s ease',
      }} />
    </div>
  );
}

/**
 * Explore — "See what you have." A quiet profile of ONE built version: how many
 * rows, and column-by-column how complete, how varied, and its range — plus a small
 * preview. Every number comes back through the governed read path, so it is already
 * scoped + masked to what the viewer is allowed to see. No machinery on show.
 */
export default function ExplorePanel({ datasetId, builtLayers }: { datasetId: string; builtLayers: Layer[] }) {
  const order: Layer[] = ['bronze', 'silver', 'gold'];
  const layers = order.filter((l) => builtLayers.includes(l));
  const [layer, setLayer] = useState<Layer>(layers[layers.length - 1] ?? 'bronze');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async (which: Layer, refresh = false) => {
    setBusy(true); setErr(''); if (!refresh) setProfile(null);
    try {
      const res = await fetch(
        `/api/data/datasets/${datasetId}/profile?layer=${which}${refresh ? '&refresh=1' : ''}`,
        { cache: 'no-store' },
      );
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Could not profile this version'); return; }
      setProfile(data);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, [datasetId]);

  useEffect(() => { if (layers.length) load(layer); }, [layer, load]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!layers.length) {
    return <div className="guided-panel"><p className="muted" style={{ marginTop: 0 }}>Build a version to explore its shape.</p></div>;
  }

  const cols = profile?.columns ?? [];

  return (
    <div className="guided-panel">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <p className="muted" style={{ margin: 0 }}>
          A quiet look at what you actually have — rows, completeness, spread and range, all masked to what you can see.
        </p>
        {layers.length > 1 ? (
          <div className="seg">
            {layers.map((l) => (
              <button key={l} className={layer === l ? 'on' : ''} onClick={() => setLayer(l)}>{l}</button>
            ))}
          </div>
        ) : null}
      </div>

      {err ? <div className="error" style={{ marginTop: 12 }}>{err}</div> : null}

      {busy && !profile ? (
        <div className="row" style={{ marginTop: 16, alignItems: 'center', gap: 8 }}>
          <span className="spin" /><span className="hint" style={{ margin: 0 }}>Profiling {layer}…</span>
        </div>
      ) : null}

      {profile && !profile.available ? (
        <p className="hint" style={{ marginTop: 14 }}>{profile.reason ?? 'Nothing to profile yet.'}</p>
      ) : null}

      {profile && profile.available ? (
        <div style={{ marginTop: 14 }}>
          <div className="row" style={{ gap: 22, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-head)', fontSize: 30, lineHeight: 1, color: 'var(--text)' }}>
                {compact(profile.rowCount ?? 0)}
              </div>
              <div className="hint" style={{ margin: '4px 0 0' }}>rows</div>
            </div>
            <div>
              <div style={{ fontFamily: 'var(--font-head)', fontSize: 30, lineHeight: 1, color: 'var(--text)' }}>
                {cols.length}
              </div>
              <div className="hint" style={{ margin: '4px 0 0' }}>columns</div>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              {profile.cached ? <span className="count-pill">cached</span> : null}
              <button className="btn ghost sm" onClick={() => load(layer, true)} disabled={busy}>
                {busy ? <span className="spin" /> : 'Recompute'}
              </button>
            </div>
          </div>

          <div className="section-title" style={{ marginTop: 18 }}>
            Columns<span className="count-pill">{profile.layer}</span>
          </div>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>Column</th><th>Type</th><th style={{ minWidth: 120 }}>Complete</th>
                  <th>Distinct</th><th>Range</th>
                </tr>
              </thead>
              <tbody>
                {cols.map((c) => {
                  const hasRange = c.min !== null || c.max !== null;
                  const canOpen = c.top.length > 0;
                  return (
                    <tr key={c.name} style={{ cursor: canOpen ? 'pointer' : 'default' }}
                      onClick={() => canOpen && setOpen(open === c.name ? null : c.name)}>
                      <td style={{ fontWeight: 500 }}>{c.name}</td>
                      <td className="mono" style={{ color: 'var(--text-faint)', fontSize: 12 }}>{c.type}</td>
                      <td>
                        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                          <NullBar pct={c.nullPct} />
                          <span className="hint" style={{ margin: 0, minWidth: 34 }}>
                            {c.nullPct === 0 ? '100%' : `${(100 - c.nullPct * 100).toFixed(c.nullPct < 0.01 ? 1 : 0)}%`}
                          </span>
                        </div>
                      </td>
                      <td>{compact(c.distinct)}</td>
                      <td className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {hasRange ? `${c.min ?? '—'} → ${c.max ?? '—'}` : <span style={{ color: 'var(--text-faint)' }}>—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {open ? (() => {
            const c = cols.find((x) => x.name === open);
            if (!c) return null;
            const max = Math.max(1, ...c.top.map((t) => t.count));
            return (
              <div style={{ marginTop: 10, padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--panel)' }}>
                <div className="hint" style={{ marginTop: 0 }}>Most common in <strong>{c.name}</strong></div>
                {c.top.map((t) => (
                  <div key={t.value} className="row" style={{ gap: 10, alignItems: 'center', marginTop: 6 }}>
                    <span className="mono" style={{ fontSize: 12, minWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.value}</span>
                    <div style={{ flex: 1, height: 6, background: 'var(--panel-2)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${(t.count / max) * 100}%`, height: '100%', background: 'var(--gold)', opacity: 0.7 }} />
                    </div>
                    <span className="hint" style={{ margin: 0, minWidth: 40, textAlign: 'right' }}>{compact(t.count)}</span>
                  </div>
                ))}
              </div>
            );
          })() : null}

          {profile.preview && profile.preview.rows.length > 0 ? (
            <>
              <div className="section-title" style={{ marginTop: 20 }}>
                Preview<span className="count-pill ok">first {profile.preview.rows.length}</span>
              </div>
              <div className="table-wrap" style={{ marginTop: 8 }}>
                <table>
                  <thead><tr>{profile.preview.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>
                    {profile.preview.rows.map((r, i) => (
                      <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
