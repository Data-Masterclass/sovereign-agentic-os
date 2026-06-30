/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';
import {
  type BetSummary, type Pillar, api, eur, fmtDate, problemLine,
} from './types';
import { ProgressBar, SignalBadge } from './ui';

type ListData = { bets: BetSummary[] };
type StrategyData = { pillars: Pillar[] };

export default function BigBetsPage() {
  const { data, loading, error } = useApi<ListData>('/api/big-bets');
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader title="Big Bets" crumb="initiative roadmaps over real components" tutorial="big-bets" />
      <div className="content">
        <p className="lead">
          Each Big Bet is an initiative with a sharp problem statement, a value target traced to a
          Strategy pillar, and a roadmap built from real artifacts — data, models, dashboards, agents,
          software. The bet shows delivery; for runtime health see{' '}
          <Link href="/monitoring" style={{ color: 'var(--teal)' }}>Monitoring</Link>.
        </p>

        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
          <div className="section-title" style={{ margin: 0 }}>
            Portfolio
            {data ? <span className="count-pill" style={{ marginLeft: 8 }}>{data.bets.length}</span> : null}
          </div>
          <button className="btn" onClick={() => setCreating(true)}>New Big Bet</button>
        </div>

        {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}
        {loading && !data ? <div className="stub-page">Loading bets…</div> : null}
        {data && data.bets.length === 0 && !loading ? (
          <div className="hint" style={{ marginTop: 16 }}>
            No big bets yet. Start one — name the problem, point it at a pillar, set a value target and a
            go-live, then build the roadmap from real components.
          </div>
        ) : null}

        <div style={{ display: 'grid', gap: 16, marginTop: 16 }}>
          {data?.bets.map((b) => <BetCard key={b.id} b={b} />)}
        </div>
      </div>

      {creating ? <CreateDrawer onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function BetCard({ b }: { b: BetSummary }) {
  return (
    <Link
      href={`/big-bets/${b.id}`}
      className="card"
      style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}
    >
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: 15, color: 'var(--text)' }}>{b.name}</h3>
            <SignalBadge signal={b.signal} />
            {b.crossDomain ? <span className="chip">cross-domain</span> : null}
          </div>
          <p className="muted" style={{ marginTop: 8, marginBottom: 0, maxWidth: 640, lineHeight: 1.5 }}>
            {problemLine(b.problem)}
          </p>
        </div>
        <div style={{ textAlign: 'right', minWidth: 150 }}>
          <div className="big" style={{ fontSize: 20, color: 'var(--gold-light)' }}>{eur(b.realized)}</div>
          <div className="muted" style={{ fontSize: 11.5 }}>realized · {eur(b.targetValue)} target</div>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 5 }}>
          <span className="muted" style={{ fontSize: 11.5 }}>
            Completion · {b.completion.done}/{b.completion.total} components
          </span>
          <span className="muted mono" style={{ fontSize: 11.5 }}>{b.completion.pct}%</span>
        </div>
        <ProgressBar pct={b.completion.pct} />
      </div>

      <div className="row" style={{ marginTop: 14, justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="chip">{b.components} component{b.components === 1 ? '' : 's'}</span>
        <span className="muted" style={{ fontSize: 11.5 }}>
          go-live {fmtDate(b.goLive)}
          {!b.goLiveRealistic ? <span style={{ color: 'var(--danger)' }}> · date at risk</span> : null}
        </span>
      </div>
    </Link>
  );
}

const EMPTY = { name: '', who: '', need: '', obstacle: '', impact: '', pillarId: '', metricId: '', targetValue: '', goLive: '' };

function CreateDrawer({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { data } = useApi<StrategyData>('/api/big-bets/strategy');
  const [f, setF] = useState({ ...EMPTY });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const pillars = useMemo(() => data?.pillars ?? [], [data]);
  const set = (k: keyof typeof EMPTY, v: string) => setF((s) => ({ ...s, [k]: v }));

  const onPillar = (id: string) => {
    const p = pillars.find((x) => x.id === id);
    setF((s) => ({ ...s, pillarId: id, metricId: p?.metric?.id ?? '' }));
  };

  const valid = Boolean(f.name.trim() && f.who.trim() && f.need.trim());

  const submit = async () => {
    if (!valid || busy) return;
    setErr('');
    setBusy(true);
    try {
      const res = (await api('/api/big-bets', 'POST', {
        name: f.name,
        problem: { who: f.who, need: f.need, obstacle: f.obstacle, impact: f.impact },
        pillarId: f.pillarId || undefined,
        metricId: f.metricId || undefined,
        targetValue: Number(f.targetValue) || 0,
        goLive: f.goLive || undefined,
      })) as { id: string };
      router.push(`/big-bets/${res.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>New Big Bet</h2>
          <button className="drawer-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="drawer-body">
          <Field label="Name" required>
            <input
              type="text"
              value={f.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="e.g. Reduce logistics churn in DACH"
            />
          </Field>

          <div className="section-title" style={{ marginTop: 22 }}>Problem statement</div>
          <p className="hint" style={{ marginTop: 0 }}>
            PM-grade and required. Who has the problem, what they need, what blocks them, and the impact
            of solving it.
          </p>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
            <Field label="Who" required>
              <input type="text" value={f.who} onChange={(e) => set('who', e.target.value)} placeholder="Retention team" />
            </Field>
            <Field label="Need" required>
              <input type="text" value={f.need} onChange={(e) => set('need', e.target.value)} placeholder="to spot at-risk accounts early" />
            </Field>
            <Field label="Obstacle">
              <input type="text" value={f.obstacle} onChange={(e) => set('obstacle', e.target.value)} placeholder="churn signals are scattered" />
            </Field>
            <Field label="Impact">
              <input type="text" value={f.impact} onChange={(e) => set('impact', e.target.value)} placeholder="saving €1.2M of NRR a year" />
            </Field>
          </div>

          <div className="section-title" style={{ marginTop: 22 }}>Value target</div>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
            <Field label="Strategy pillar">
              <select value={f.pillarId} onChange={(e) => onPillar(e.target.value)} style={{ width: '100%' }}>
                <option value="">Default (Retention)</option>
                {pillars.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.metric ? ` → ${p.metric.name}` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Target value (€)">
              <input
                type="number"
                value={f.targetValue}
                onChange={(e) => set('targetValue', e.target.value)}
                placeholder="1200000"
                style={{ width: '100%' }}
              />
            </Field>
            <Field label="Go-live">
              <input type="date" value={f.goLive} onChange={(e) => set('goLive', e.target.value)} style={{ width: '100%' }} />
            </Field>
          </div>

          {err ? <div className="error" style={{ marginTop: 16 }}>{err}</div> : null}

          <div className="row" style={{ marginTop: 24, justifyContent: 'flex-end', gap: 10 }}>
            <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn" onClick={submit} disabled={!valid || busy}>
              {busy ? <span className="spin" /> : 'Create Big Bet'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <span className="muted" style={{ fontSize: 11.5, display: 'block', marginBottom: 5 }}>
        {label}{required ? <span style={{ color: 'var(--danger)' }}> *</span> : null}
      </span>
      {children}
    </label>
  );
}
