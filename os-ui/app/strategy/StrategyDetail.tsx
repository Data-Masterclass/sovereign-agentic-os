/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  euro,
  KIND_LABEL,
  type Pillar,
  type DistributedBet,
  type Trend,
  type Quarter,
  type ArtifactKind,
} from '@/lib/strategy/model';
import TargetsDrawer from './TargetsDrawer';

const TREND_CLASS: Record<Trend, string> = {
  'on-track': 'badge ok',
  behind: 'badge err',
  'no-target': 'badge muted',
};
const TREND_LABEL: Record<Trend, string> = {
  'on-track': 'On track',
  behind: 'Behind',
  'no-target': 'No target',
};
function trendBadge(t: Trend) {
  return <span className={TREND_CLASS[t]}>{TREND_LABEL[t]}</span>;
}

// Client-side mirrors of the (server-only) roll-up + progress shapes the API
// returns — kept local so we never import server-only modules into the bundle.
type Rollup = {
  metricTitle: string;
  total: number;
  source: 'cube' | 'seed-offline';
  basis: string;
  bets: DistributedBet[];
  decomposedTotal: number;
  reconciled: boolean;
  visibleTotal: number;
  maskedTotal: number;
};
type MetricProgress = {
  key: string;
  label: string;
  unit: 'eur' | 'count';
  annualTarget: number;
  quarterTarget: number;
  quarter: Quarter;
  actual: number;
  trend: Trend;
  pct: number;
};
type Progress = {
  hasTargets: boolean;
  asOfMonth: string;
  rows: MetricProgress[];
  certified: MetricProgress[];
  history: { month: string }[];
};
type AuditEvent = { action: string; actor: string; at: string; detail?: Record<string, unknown> };
type DetailResp = {
  pillar: Pillar;
  rollup: Rollup;
  progress: Progress;
  audit: AuditEvent[];
  canEdit: boolean;
};

export default function StrategyDetail({ pillarId, onChanged }: { pillarId: string; onChanged: () => void }) {
  const [data, setData] = useState<DetailResp | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [openBet, setOpenBet] = useState<string | null>(null);
  const [editTargets, setEditTargets] = useState(false);
  const [linking, setLinking] = useState(false);
  const [betCatalogue, setBetCatalogue] = useState<{ id: string; name: string; domain: string }[]>([]);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch(`/api/strategy/pillars/${pillarId}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed to load pillar');
      setData(body as DetailResp);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [pillarId]);

  useEffect(() => {
    load();
  }, [load]);

  const act = useCallback(
    async (fn: () => Promise<Response>) => {
      setBusy(true);
      setError('');
      try {
        const res = await fn();
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? 'Action failed');
        await load();
        onChanged();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [load, onChanged],
  );

  const openLink = useCallback(async () => {
    setLinking(true);
    const res = await fetch('/api/strategy/catalogue', { cache: 'no-store' });
    if (res.ok) {
      const j = await res.json();
      setBetCatalogue(j.bets ?? []);
    }
  }, []);

  if (error && !data) return <div className="error">{error}</div>;
  if (!data) return <div className="stub-page">Loading pillar…</div>;

  const { pillar, rollup, progress, audit, canEdit } = data;

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {/* Header */}
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div className="row" style={{ alignItems: 'center', gap: 10 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>{pillar.name}</h3>
              <span className={`badge ${pillar.scope === 'tenant' ? 'ok' : 'muted'}`}>
                {pillar.scope === 'tenant' ? 'shared · tenant' : `domain · ${pillar.domain}`}
              </span>
            </div>
            <p className="muted" style={{ marginTop: 8, marginBottom: 0, maxWidth: 600, whiteSpace: 'normal' }}>
              {pillar.description || 'No description.'}
            </p>
          </div>
          <div style={{ textAlign: 'right', minWidth: 160 }}>
            <div className="big" style={{ fontSize: 24, color: 'var(--gold-light)' }}>{euro(rollup.total)}</div>
            <div className="muted" style={{ fontSize: 11.5 }}>{rollup.metricTitle}</div>
            <div className="muted mono" style={{ fontSize: 10.5, marginTop: 2 }}>
              basis: {rollup.basis} · {rollup.source === 'cube' ? 'live Cube' : 'offline seed'}
            </div>
          </div>
        </div>

        {canEdit ? (
          <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button className="btn sm" disabled={busy} onClick={() => setEditTargets(true)}>Set targets</button>
            <button className="btn sm ghost" disabled={busy} onClick={openLink}>Link Big Bet</button>
            <button
              className="btn sm ghost"
              disabled={busy}
              onClick={() => act(() => fetch(`/api/strategy/pillars/${pillarId}/snapshot`, { method: 'POST' }))}
            >
              Snapshot actuals
            </button>
            <button
              className="btn sm ghost"
              disabled={busy}
              style={{ marginLeft: 'auto', color: 'var(--danger)' }}
              onClick={() => {
                if (confirm(`Delete pillar "${pillar.name}"?`)) {
                  act(() => fetch(`/api/strategy/pillars/${pillarId}`, { method: 'DELETE' })).then(onChanged);
                }
              }}
            >
              Delete
            </button>
          </div>
        ) : (
          <div className="hint" style={{ marginTop: 12 }}>
            You can view this pillar. Defining pillars + targets is a Builder (domain) / Admin (tenant) action.
          </div>
        )}
        {error ? <div className="error" style={{ marginTop: 10 }}>{error}</div> : null}
      </div>

      {/* Value roll-up + drill */}
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="section-title" style={{ marginTop: 0 }}>Value roll-up · pillar → bet → component</div>
          <span className={`badge ${rollup.reconciled ? 'ok' : 'err'}`}>
            {rollup.reconciled ? 'reconciles ✓' : 'drift ✗'}
          </span>
        </div>

        {rollup.bets.length === 0 ? (
          <div className="muted" style={{ fontSize: 12.5 }}>
            No Big Bets linked yet. {canEdit ? 'Link a bet to distribute the pillar value.' : ''}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {rollup.bets.map((b) => (
              <div key={b.id} className="card" style={{ padding: '10px 12px', background: 'var(--bg-input)' }}>
                <button
                  onClick={() => setOpenBet(openBet === b.id ? null : b.id)}
                  className="row"
                  style={{ width: '100%', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', background: 'none', border: 'none', padding: 0, color: 'inherit' }}
                >
                  <div className="row" style={{ alignItems: 'center', gap: 8 }}>
                    <span className="muted mono" style={{ fontSize: 11 }}>{openBet === b.id ? '▾' : '▸'}</span>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{b.name}</span>
                    <span className="badge muted" style={{ fontSize: 10 }}>{b.domain}</span>
                    {b.entitled && b.sharePct !== null ? (
                      <span className="muted mono" style={{ fontSize: 10.5 }}>{Math.round(b.sharePct * 100)}%</span>
                    ) : null}
                  </div>
                  <div className="mono" style={{ fontWeight: 600, color: b.entitled ? 'var(--gold-light)' : 'var(--text-faint)' }}>
                    {b.entitled ? euro(b.value) : 'restricted'}
                  </div>
                </button>

                {openBet === b.id ? (
                  <div style={{ marginTop: 8, paddingLeft: 18, display: 'grid', gap: 4 }}>
                    {b.entitled ? (
                      b.components.map((c) => (
                        <div key={c.id} className="row" style={{ justifyContent: 'space-between', fontSize: 12 }}>
                          <span className="row" style={{ gap: 8, alignItems: 'center' }}>
                            <span className="badge muted" style={{ fontSize: 9.5 }}>{KIND_LABEL[c.kind as ArtifactKind]}</span>
                            <span className="muted">{c.name}</span>
                          </span>
                          <span className="mono">{euro(c.value)}</span>
                        </div>
                      ))
                    ) : (
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        Restricted — you are not entitled to the {b.domain} domain&apos;s values (RLS).
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        <div className="hint" style={{ marginTop: 10 }}>
          You see {euro(rollup.visibleTotal)} of {euro(rollup.total)}
          {rollup.maskedTotal > 0 ? ` · ${euro(rollup.maskedTotal)} in domains you cannot see (RLS)` : ''}.
          Σ of all bet shares reconciles to the pillar metric.
        </div>
      </div>

      {/* Targets vs actuals */}
      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          Targets vs actuals · annual + Q{progress.rows[0]?.quarter?.slice(1) ?? ''} · as of {progress.asOfMonth}
        </div>
        {!progress.hasTargets ? (
          <div className="muted" style={{ fontSize: 12.5 }}>
            No targets set. {canEdit ? 'Set annual + quarterly targets to track value, active people, and certified counts.' : ''}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Target</th>
                  <th style={{ textAlign: 'right' }}>Actual</th>
                  <th style={{ textAlign: 'right' }}>Quarter</th>
                  <th style={{ textAlign: 'right' }}>Annual</th>
                  <th>Progress</th>
                  <th style={{ textAlign: 'center' }}>Trend</th>
                </tr>
              </thead>
              <tbody>
                {[...progress.rows, ...progress.certified.filter((c) => c.annualTarget > 0)].map((r) => (
                  <ProgressRow key={r.key} r={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {progress.history.length > 0 ? (
          <div className="hint">{progress.history.length} monthly snapshot{progress.history.length === 1 ? '' : 's'} captured.</div>
        ) : null}
      </div>

      {/* Audit feed */}
      {audit.length > 0 ? (
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>Audit · recent edits</div>
          <div style={{ display: 'grid', gap: 5 }}>
            {audit.map((e, i) => (
              <div key={i} className="row" style={{ justifyContent: 'space-between', fontSize: 11.5 }}>
                <span className="mono">{e.action}</span>
                <span className="muted">{e.actor} · {new Date(e.at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {editTargets ? (
        <TargetsDrawer
          pillar={pillar}
          onClose={() => setEditTargets(false)}
          onSaved={() => { setEditTargets(false); load(); onChanged(); }}
        />
      ) : null}

      {linking ? (
        <LinkBetDrawer
          pillarId={pillarId}
          linkedIds={pillar.betIds}
          catalogue={betCatalogue}
          onClose={() => setLinking(false)}
          onDone={() => { setLinking(false); load(); onChanged(); }}
        />
      ) : null}
    </div>
  );
}

function ProgressRow({ r }: { r: MetricProgress }) {
  const fmt = (n: number) => (r.unit === 'eur' ? euro(n) : String(n));
  const label = r.key.startsWith('certified.') ? `Certified ${KIND_LABEL[r.key.split('.')[1] as ArtifactKind]}` : r.label;
  return (
    <tr>
      <td style={{ fontWeight: 600 }}>{label}</td>
      <td style={{ textAlign: 'right' }} className="mono">{fmt(r.actual)}</td>
      <td style={{ textAlign: 'right' }} className="mono muted">{fmt(r.quarterTarget)}</td>
      <td style={{ textAlign: 'right' }} className="mono muted">{fmt(r.annualTarget)}</td>
      <td style={{ minWidth: 120 }}>
        <div style={{ height: 6, borderRadius: 999, background: 'var(--bg)', border: '1px solid var(--border)', overflow: 'hidden' }}>
          <div style={{ width: `${Math.round(r.pct * 100)}%`, height: '100%', background: r.trend === 'behind' ? 'var(--danger)' : 'linear-gradient(90deg, var(--gold-deep), var(--gold-light))' }} />
        </div>
      </td>
      <td style={{ textAlign: 'center' }}>{trendBadge(r.trend)}</td>
    </tr>
  );
}

function LinkBetDrawer({
  pillarId,
  linkedIds,
  catalogue,
  onClose,
  onDone,
}: {
  pillarId: string;
  linkedIds: string[];
  catalogue: { id: string; name: string; domain: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const link = async (betId: string, remove: boolean) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(
        `/api/strategy/pillars/${pillarId}/bets${remove ? `?betId=${betId}` : ''}`,
        remove ? { method: 'DELETE' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ betId }) },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Failed');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>Link Big Bets</h2>
          <button className="drawer-x" onClick={onClose}>×</button>
        </div>
        <div className="drawer-body">
          <p className="muted" style={{ fontSize: 12.5 }}>
            Attach the Big Bets that deliver this pillar. Each bet&apos;s share of the pillar metric is
            stubbed here (the Big Bets tab owns the real distribution); shares re-normalise to reconcile.
          </p>
          {error ? <div className="error">{error}</div> : null}
          <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
            {catalogue.map((b) => {
              const on = linkedIds.includes(b.id);
              return (
                <div key={b.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{b.name}</span>
                    <span className="badge muted" style={{ fontSize: 10 }}>{b.domain}</span>
                  </span>
                  <button className={`btn sm ${on ? 'ghost' : ''}`} disabled={busy} onClick={() => link(b.id, on)}>
                    {on ? 'Unlink' : 'Link'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
