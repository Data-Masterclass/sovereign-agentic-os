/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations, useFormat, useServerMessage } from '@core/i18n/client';
import type { Formatters } from '@core/i18n/format';
import QueryError from '@tabs/data/ui/QueryError';

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

/** The panel's own compact count (34.5k → "35k" above 10k) — kept byte-identical in English;
 *  every other language uses the shared locale-aware compact form. */
function compactEn(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
function compactIn(f: Formatters, n: number): string {
  return f.locale === 'en' ? compactEn(n) : f.compact(n);
}
/** `pct` (0..1) as a percentage with exactly `digits` decimals — "0.50%", "100%" in English. */
function percent(f: Formatters, pct: number, digits: number): string {
  return f.number(pct, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** A whisper-quiet null-density bar: empty when a column is complete, warming only
 *  as gaps grow — so a dirty column shows itself without shouting. */
function NullBar({ pct }: { pct: number }) {
  const t = useTranslations('data');
  const f = useFormat();
  const w = Math.max(0, Math.min(1, pct)) * 100;
  const warm = pct >= 0.2;
  return (
    <div title={t('explore.emptyPct', { pct: percent(f, pct, pct > 0 && pct < 0.01 ? 2 : 0) })}
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
export default function ExplorePanel({ datasetId, builtLayers, showPreview = true }: { datasetId: string; builtLayers: Layer[]; showPreview?: boolean }) {
  const t = useTranslations('data');
  const serverMsg = useServerMessage();
  const f = useFormat();
  const compact = (n: number) => compactIn(f, n);
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
      if (!res.ok) { setErr(serverMsg(data, t('explore.profileFailed'))); return; }
      setProfile(data);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, [datasetId, t]);

  useEffect(() => { if (layers.length) load(layer); }, [layer, load]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!layers.length) {
    return <div className="guided-panel"><p className="muted" style={{ marginTop: 0 }}>{t('explore.noVersion')}</p></div>;
  }

  const cols = profile?.columns ?? [];

  return (
    <div className="guided-panel">
      <div className="row" style={{ justifyContent: 'flex-end', alignItems: 'center', gap: 10 }}>
        {layers.length > 1 ? (
          <div className="bsg-seg" role="group" aria-label={t('explore.layerAria')}>
            {layers.map((l) => (
              <button
                key={l}
                type="button"
                className={`bsg-tier bsg-${l}${layer === l ? ' on' : ''}`}
                aria-pressed={layer === l}
                onClick={() => setLayer(l)}
              >
                {t(`explore.layer.${l}`)}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* Bronze/Silver/Gold layer picker: each tier its own colour, the highest
          available tier selected by default (see initial state), click to switch. */}
      {/* i18n-ignore: CSS, not prose */}
      <style>{`
        .bsg-seg { display: inline-flex; gap: 6px; flex-shrink: 0; }
        .bsg-tier {
          padding: 3px 12px; border-radius: 6px; font-size: 12px; font-weight: 600;
          cursor: pointer; background: transparent; transition: background .12s, color .12s;
          border: 1px solid transparent;
        }
        .bsg-bronze { color: #c8813f; border-color: #c8813f55; }
        .bsg-silver { color: #9aa1ab; border-color: #9aa1ab55; }
        .bsg-gold   { color: var(--gold-text, #d4af37); border-color: #d4af3755; }
        .bsg-tier.on.bsg-bronze { background: #c8813f; border-color: #c8813f; color: #1a1205; }
        .bsg-tier.on.bsg-silver { background: #c9ccd1; border-color: #c9ccd1; color: #16181c; }
        .bsg-tier.on.bsg-gold   { background: var(--gold, #d4af37); border-color: var(--gold, #d4af37); color: #1a1205; }
      `}</style>

      {err ? <QueryError error={err} style={{ marginTop: 12 }} /> : null}

      {busy && !profile ? (
        <div className="row" style={{ marginTop: 16, alignItems: 'center', gap: 8 }}>
          <span className="spin" /><span className="hint" style={{ margin: 0 }}>{t('explore.profiling', { layer })}</span>
        </div>
      ) : null}

      {profile && !profile.available ? (
        <p className="hint" style={{ marginTop: 14 }}>{profile.reason ?? t('explore.nothingYet')}</p>
      ) : null}

      {profile && profile.available ? (
        <div style={{ marginTop: 14 }}>
          <div className="row" style={{ gap: 22, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-head)', fontSize: 30, lineHeight: 1, color: 'var(--text)' }}>
                {compact(profile.rowCount ?? 0)}
              </div>
              <div className="hint" style={{ margin: '4px 0 0' }}>{t('explore.rows')}</div>
            </div>
            <div>
              <div style={{ fontFamily: 'var(--font-head)', fontSize: 30, lineHeight: 1, color: 'var(--text)' }}>
                {cols.length}
              </div>
              <div className="hint" style={{ margin: '4px 0 0' }}>{t('explore.columns')}</div>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              {profile.cached ? <span className="count-pill">{t('explore.cached')}</span> : null}
              <button className="btn ghost sm" onClick={() => load(layer, true)} disabled={busy}>
                {busy ? <span className="spin" /> : t('explore.recompute')}
              </button>
            </div>
          </div>

          <div className="section-title" style={{ marginTop: 18 }}>
            {t('explore.columnsTitle')}<span className="count-pill">{profile.layer ? t('explore.layerPill', { layer: profile.layer }) : null}</span>
          </div>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>{t('explore.col.column')}</th><th>{t('explore.col.type')}</th><th style={{ minWidth: 120 }}>{t('explore.col.complete')}</th>
                  <th>{t('explore.col.distinct')}</th><th>{t('explore.col.range')}</th>
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
                            {c.nullPct === 0 ? percent(f, 1, 0) : percent(f, 1 - c.nullPct, c.nullPct < 0.01 ? 1 : 0)}
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
            const max = Math.max(1, ...c.top.map((tv) => tv.count));
            return (
              <div style={{ marginTop: 10, padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--panel)' }}>
                <div className="hint" style={{ marginTop: 0 }}>{t.rich('explore.mostCommon', { column: c.name, strong: (ch) => <strong>{ch}</strong> })}</div>
                {c.top.map((tv) => (
                  <div key={tv.value} className="row" style={{ gap: 10, alignItems: 'center', marginTop: 6 }}>
                    <span className="mono" style={{ fontSize: 12, minWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tv.value}</span>
                    <div style={{ flex: 1, height: 6, background: 'var(--panel-2)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${(tv.count / max) * 100}%`, height: '100%', background: 'var(--gold)', opacity: 0.7 }} />
                    </div>
                    <span className="hint" style={{ margin: 0, minWidth: 40, textAlign: 'right' }}>{compact(tv.count)}</span>
                  </div>
                ))}
              </div>
            );
          })() : null}

          {showPreview && profile.preview && profile.preview.rows.length > 0 ? (
            <>
              <div className="section-title" style={{ marginTop: 20 }}>
                {t('explore.preview')}<span className="count-pill ok">{t('explore.firstN', { count: profile.preview.rows.length })}</span>
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
