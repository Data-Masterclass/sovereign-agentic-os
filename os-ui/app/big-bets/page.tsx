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

/** Currency glyph for a pillar metric's unit (count → no symbol). */
function unitGlyph(unit?: string): string {
  if (unit === '€') return '€';
  if (unit === '%') return '%';
  return '';
}

export default function BigBetsPage() {
  const { data, loading, error } = useApi<ListData>('/api/big-bets');
  const { data: strat } = useApi<StrategyData>('/api/big-bets/strategy');
  const [creating, setCreating] = useState(false);

  const pillars = useMemo(() => strat?.pillars ?? [], [strat]);
  const bets = data?.bets ?? [];

  // Group the portfolio by strategic pillar — each pillar is its own section.
  const groups = useMemo(() => groupByPillar(bets, pillars), [bets, pillars]);

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
            {data ? <span className="count-pill" style={{ marginLeft: 8 }}>{bets.length}</span> : null}
          </div>
          <button className="btn" onClick={() => setCreating(true)}>New Big Bet</button>
        </div>

        {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}
        {loading && !data ? <div className="stub-page">Loading bets…</div> : null}
        {data && bets.length === 0 && !loading ? (
          <div className="hint" style={{ marginTop: 16 }}>
            No big bets yet. Start one — name the owner, point it at a pillar, state the problem and your
            solution idea, set a value target and a go-live, then build the roadmap from real components.
          </div>
        ) : null}

        <div className="bb-portfolio">
          {groups.map((g) => (
            <section key={g.key} className="bb-group">
              <div className="bb-group-head">
                <h3 className="bb-group-title">{g.name}</h3>
                <span className="count-pill">{g.bets.length}</span>
                {g.metricName ? <span className="bb-group-metric">{g.metricName}</span> : null}
              </div>
              <div className="bb-group-bets">
                {g.bets.map((b) => <BetCard key={b.id} b={b} />)}
              </div>
            </section>
          ))}
        </div>
      </div>

      {creating ? <CreateDrawer pillars={pillars} onClose={() => setCreating(false)} /> : null}
    </>
  );
}

type PortfolioGroup = { key: string; name: string; metricName?: string; bets: BetSummary[] };

/** Bucket bets under their pillar (named), preserving pillar order; stragglers last. */
function groupByPillar(bets: BetSummary[], pillars: Pillar[]): PortfolioGroup[] {
  const byId = new Map(pillars.map((p) => [p.id, p]));
  const buckets = new Map<string, BetSummary[]>();
  for (const b of bets) {
    const key = byId.has(b.pillarId) ? b.pillarId : '__none__';
    const arr = buckets.get(key) ?? [];
    arr.push(b);
    buckets.set(key, arr);
  }
  const out: PortfolioGroup[] = [];
  for (const p of pillars) {
    const arr = buckets.get(p.id);
    if (arr && arr.length) out.push({ key: p.id, name: p.name, metricName: p.metric?.name, bets: arr });
  }
  const none = buckets.get('__none__');
  if (none && none.length) out.push({ key: '__none__', name: 'Unassigned', bets: none });
  return out;
}

function BetCard({ b }: { b: BetSummary }) {
  const archived = b.status === 'archived';
  return (
    <Link
      href={`/big-bets/${b.id}`}
      className="card"
      style={{ display: 'block', textDecoration: 'none', color: 'inherit', opacity: archived ? 0.62 : 1 }}
    >
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: 15, color: 'var(--text)' }}>{b.name}</h3>
            {archived ? <span className="chip">archived</span> : <SignalBadge signal={b.signal} />}
            {b.crossDomain ? <span className="chip">cross-domain</span> : null}
          </div>
          <p className="muted" style={{ marginTop: 8, marginBottom: 0, maxWidth: 640, lineHeight: 1.5 }}>
            {problemLine(b.problem)}
          </p>
          {b.problem.who ? (
            <p className="muted" style={{ marginTop: 6, marginBottom: 0, fontSize: 11.5 }}>owner · {b.problem.who}</p>
          ) : null}
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
          {!b.goLiveRealistic && !archived ? <span style={{ color: 'var(--danger)' }}> · date at risk</span> : null}
        </span>
      </div>
    </Link>
  );
}

const EMPTY = { owner: '', pillarId: '', metricId: '', problem: '', solution: '', targetValue: '', goLive: '' };

function CreateDrawer({ pillars, onClose }: { pillars: Pillar[]; onClose: () => void }) {
  const router = useRouter();
  const [f, setF] = useState({ ...EMPTY });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const set = (k: keyof typeof EMPTY, v: string) => setF((s) => ({ ...s, [k]: v }));

  const pillar = useMemo(() => pillars.find((p) => p.id === f.pillarId) ?? null, [pillars, f.pillarId]);
  const onPillar = (id: string) => {
    const p = pillars.find((x) => x.id === id);
    setF((s) => ({ ...s, pillarId: id, metricId: p?.metric?.id ?? '' }));
  };

  const valid = Boolean(f.problem.trim());

  const submit = async () => {
    if (!valid || busy) return;
    setErr('');
    setBusy(true);
    try {
      const res = (await api('/api/big-bets', 'POST', {
        owner: f.owner,
        problem: f.problem,
        solution: f.solution,
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

  const glyph = unitGlyph(pillar?.metric?.unit);
  const valueLabel = pillar?.metric
    ? `Value · ${pillar.metric.name}${glyph ? ` (${glyph})` : ''}`
    : 'Value target';

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>New Big Bet</h2>
          <button className="drawer-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="drawer-body">
          <Field label="Owner">
            <input
              type="text"
              value={f.owner}
              onChange={(e) => set('owner', e.target.value)}
              placeholder="e.g. Retention team"
            />
          </Field>

          <Field label="Strategic Pillar">
            {pillar ? (
              <div className="bb-pillar-chip">
                <span className="bb-pillar-chip-name">{pillar.name}</span>
                {pillar.metric ? <span className="bb-pillar-chip-metric">→ {pillar.metric.name}</span> : null}
                <button type="button" className="bb-pillar-chip-edit" onClick={() => onPillar('')}>Edit</button>
              </div>
            ) : (
              <select
                className="bb-pillar-select"
                value={f.pillarId}
                onChange={(e) => onPillar(e.target.value)}
                style={{ width: '100%' }}
              >
                <option value="">Choose a strategic pillar…</option>
                {pillars.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.metric ? ` → ${p.metric.name}` : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Problem Statement" required>
            <textarea
              value={f.problem}
              rows={3}
              onChange={(e) => set('problem', e.target.value)}
              placeholder="The problem this bet solves — who is affected and what it costs the business."
            />
          </Field>

          <Field label="Solution Idea">
            <textarea
              value={f.solution}
              rows={3}
              onChange={(e) => set('solution', e.target.value)}
              placeholder="How you intend to realize the value — the shape of the solution."
            />
          </Field>

          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr', marginTop: 18 }}>
            <Field label={valueLabel}>
              <input
                type="number"
                value={f.targetValue}
                onChange={(e) => set('targetValue', e.target.value)}
                placeholder="1200000"
                style={{ width: '100%' }}
              />
            </Field>
            <Field label="Planned Go-Live">
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
    <label style={{ display: 'block', marginTop: 16 }}>
      <span className="muted" style={{ fontSize: 11.5, display: 'block', marginBottom: 5 }}>
        {label}{required ? <span style={{ color: 'var(--danger)' }}> *</span> : null}
      </span>
      {children}
    </label>
  );
}
