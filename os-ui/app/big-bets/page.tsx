/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import { useUser } from '@/lib/useUser';
import { useTileOrder } from '@/lib/prefs/useTileOrder';
import {
  type BetSummary, type Pillar, api, eur, fmtDate, problemLine,
} from './types';
import { ProgressBar, SignalBadge } from './ui';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import type { Visibility as LcVisibility } from '@/lib/core/lifecycle';
import DomainTag from '@/components/DomainTag';
import {
  PILLAR_SCOPE_LABEL,
  betTier,
  type PillarScope,
} from '@/lib/strategy/model';

/** A bet's reach → the OS-wide lifecycle visibility (cross-domain bets affect others). */
const betVisibility = (b: BetSummary): LcVisibility => (b.crossDomain ? 'shared' : 'personal');

type ListData = { bets: BetSummary[] };
type StrategyData = {
  pillars: Pillar[];
  canCreatePillar: boolean;
  userDomains: string[];
};

/** Currency glyph for a pillar metric's unit (count → no symbol). */
function unitGlyph(unit?: string): string {
  if (unit === '€') return '€';
  if (unit === '%') return '%';
  return '';
}

// Stable references for useTileOrder (memoization holds across renders).
const NO_BETS: BetSummary[] = [];
const betIdOf = (b: BetSummary) => b.id;

/** The three strategy tiers as a segment (+ All), mirroring the Strategy tab. */
type TierKey = 'all' | PillarScope;
const TIER_SEG: { key: TierKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'personal', label: PILLAR_SCOPE_LABEL.personal }, // My
  { key: 'domain', label: PILLAR_SCOPE_LABEL.domain },
  { key: 'tenant', label: PILLAR_SCOPE_LABEL.tenant }, // Company
];

export default function BigBetsPage() {
  // useSearchParams() must sit under a Suspense boundary or `next build`'s static
  // prerender of this route bails out. Wrap the client page.
  return (
    <Suspense fallback={null}>
      <BigBetsPageInner />
    </Suspense>
  );
}

function BigBetsPageInner() {
  const [data, setData] = useState<ListData | null>(null);
  const [strat, setStrat] = useState<StrategyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const { user } = useUser();
  const searchParams = useSearchParams();
  // ?pillar=<id> from a Strategy-tab "New bet under this pillar" link pre-fills
  // the pillar picker and opens the create panel automatically.
  const initPillarId = searchParams.get('pillar') ?? '';
  const [creating, setCreating] = useState(!!initPillarId);
  const [tier, setTier] = useState<TierKey>('all');

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [betsRes, stratRes] = await Promise.all([
        fetch(`/api/big-bets${showArchived ? '?archived=1' : ''}`, { cache: 'no-store' }),
        fetch('/api/big-bets/strategy', { cache: 'no-store' }),
      ]);
      const betsBody = await betsRes.json();
      if (!betsRes.ok) setError(betsBody.error ?? `Request failed (${betsRes.status})`);
      else setData(betsBody as ListData);
      if (stratRes.ok) setStrat(await stratRes.json() as StrategyData);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [showArchived]);

  useEffect(() => { void reload(); }, [reload]);

  // A bet is the caller's to manage when they own it or are an Admin (the route
  // re-checks either way — this only decides whether to surface the controls).
  const canManage = useCallback(
    (b: BetSummary) => !!user && (b.owner === user.id || user.role === 'admin'),
    [user],
  );

  const pillars = useMemo(() => strat?.pillars ?? [], [strat]);
  const allBets = data?.bets ?? NO_BETS;

  // A bet inherits its parent pillar's tier by containment (unlinked → My).
  const pillarScopeById = useMemo(
    () => new Map<string, PillarScope>(pillars.map((p) => [p.id, (p.scope as PillarScope) ?? 'personal'])),
    [pillars],
  );
  const tierOf = useCallback(
    (b: BetSummary) => betTier(b.pillarId, pillarScopeById),
    [pillarScopeById],
  );
  // Active bets only for tier counts (archived bets don't count toward the segment totals).
  const activeBets = useMemo(() => allBets.filter((b) => b.status !== 'archived'), [allBets]);
  const tierCount = useCallback(
    (k: TierKey) => activeBets.filter((b) => k === 'all' || tierOf(b) === k).length,
    [activeBets, tierOf],
  );
  // Bets shown for the selected tier — the existing pillar grouping runs WITHIN it.
  const bets = useMemo(
    () => (tier === 'all' ? allBets : allBets.filter((b) => tierOf(b) === tier)),
    [allBets, tier, tierOf],
  );

  // The bet list renders in pillar groups — constrain drops to the source's
  // group so a cross-group highlight never promises a move the re-grouping
  // would undo. Mirrors groupByPillar's bucketing (unknown pillar → Unassigned).
  const pillarIds = useMemo(() => new Set(pillars.map((p) => p.id)), [pillars]);
  const groupOf = useCallback(
    (b: BetSummary) => (b.pillarId && pillarIds.has(b.pillarId) ? b.pillarId : '__none__'),
    [pillarIds],
  );

  // Tile-order drag — everyone can arrange their own bet view.
  const { orderedItems: orderedBets, itemDragProps, dragHandleProps } = useTileOrder(
    'bigbets.list',
    bets,
    betIdOf,
    { groupOf },
  );

  // Group the portfolio by strategic pillar — each pillar is its own section.
  // Uses orderedBets so user's drag preference flows into the groups.
  const groups = useMemo(() => groupByPillar(orderedBets, pillars), [orderedBets, pillars]);

  return (
    <ConfirmProvider>
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
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn ghost"
              style={{ opacity: showArchived ? 1 : 0.7 }}
              onClick={() => setShowArchived((s) => !s)}
              title="Archived bets are hidden by default"
            >
              {showArchived ? 'Hide archived' : 'Show archived'}
            </button>
            <button className="btn" onClick={() => setCreating(true)}>New Big Bet</button>
          </div>
        </div>

        {/* Tier switcher — My · Domain · Company. A bet's tier is its pillar's tier
            by containment; the pillar grouping below runs within the selected tier. */}
        {!creating ? (
          <div className="seg" style={{ marginTop: 12 }}>
            {TIER_SEG.map((t) => (
              <button key={t.key} type="button" className={tier === t.key ? 'on' : ''} onClick={() => setTier(t.key)}>
                {t.label}{t.key !== 'all' ? ` (${tierCount(t.key)})` : ''}
              </button>
            ))}
          </div>
        ) : null}

        {creating ? (
          <CreatePanel
            pillars={pillars}
            canCreatePillar={strat?.canCreatePillar ?? false}
            userDomains={strat?.userDomains ?? []}
            initPillarId={initPillarId}
            onClose={() => setCreating(false)}
          />
        ) : (
          <>
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
                    {g.bets.map((b) => (
                      <BetCard
                        key={b.id}
                        b={b}
                        dragProps={itemDragProps(b)}
                        dragHandleProps={dragHandleProps}
                        canManage={canManage(b)}
                        onChanged={reload}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </ConfirmProvider>
  );
}

type PortfolioGroup = { key: string; name: string; metricName?: string; bets: BetSummary[] };

/** Bucket bets under their pillar (named), preserving pillar order; stragglers last. */
function groupByPillar(bets: BetSummary[], pillars: Pillar[]): PortfolioGroup[] {
  const byId = new Map(pillars.map((p) => [p.id, p]));
  const buckets = new Map<string, BetSummary[]>();
  for (const b of bets) {
    const key = b.pillarId && byId.has(b.pillarId) ? b.pillarId : '__none__';
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

type DragHandleProps = { onMouseDown: (e: React.MouseEvent) => void };
type ItemDragProps = ReturnType<ReturnType<typeof useTileOrder>['itemDragProps']>;

function BetCard({
  b,
  dragProps,
  dragHandleProps,
  canManage,
  onChanged,
}: {
  b: BetSummary;
  dragProps?: ItemDragProps;
  dragHandleProps?: DragHandleProps;
  canManage?: boolean;
  onChanged?: () => void;
}) {
  const archived = b.status === 'archived';
  return (
    <div
      className="bb-bet-row"
      style={{ position: 'relative' }}
      {...(dragProps ?? {})}
    >
      {dragHandleProps ? (
        <span
          className="drag-handle"
          style={{ position: 'absolute', top: 14, left: 10, zIndex: 1 }}
          title="Drag to reorder"
          aria-label="Drag to reorder"
          {...dragHandleProps}
        >
          ⋮⋮
        </span>
      ) : null}
      <Link
        href={`/big-bets/${b.id}`}
        className="card"
        style={{ display: 'block', textDecoration: 'none', color: 'inherit', opacity: archived ? 0.62 : 1, paddingLeft: dragHandleProps ? 28 : undefined }}
      >
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ flex: 1 }}>
            <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h3 style={{ margin: 0, fontSize: 15, color: 'var(--text)' }}>{b.name}</h3>
              {archived ? <span className="chip">archived</span> : <SignalBadge signal={b.signal} />}
              {b.crossDomain ? <DomainTag domain={b.domain} /> : null}
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
      {canManage ? (
        <div className="row" style={{ gap: 6, marginTop: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <LifecycleActions
            id={b.id}
            name={b.name}
            kind="bigbet"
            visibility={betVisibility(b)}
            archived={archived}
            api={`/api/big-bets/${b.id}`}
            onChanged={onChanged}
            compact
            surface="tile"
          />
        </div>
      ) : null}
    </div>
  );
}

const EMPTY = { owner: '', pillarId: '', metricId: '', problem: '', solution: '', targetValue: '', goLive: '' };
const EMPTY_PILLAR = { name: '', description: '' };

function CreatePanel({
  pillars: initialPillars,
  canCreatePillar,
  userDomains,
  initPillarId = '',
  onClose,
}: {
  pillars: Pillar[];
  canCreatePillar: boolean;
  userDomains: string[];
  /** Pre-fill (and lock) the pillar when navigating from the Strategy tab. */
  initPillarId?: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [f, setF] = useState({ ...EMPTY, pillarId: initPillarId });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // inline pillar create state
  const [pillars, setPillars] = useState(initialPillars);
  const [showNewPillar, setShowNewPillar] = useState(false);
  const [np, setNp] = useState({ ...EMPTY_PILLAR });
  const [npBusy, setNpBusy] = useState(false);
  const [npErr, setNpErr] = useState('');

  const set = (k: keyof typeof EMPTY, v: string) => setF((s) => ({ ...s, [k]: v }));
  const setNpField = (k: keyof typeof EMPTY_PILLAR, v: string) => setNp((s) => ({ ...s, [k]: v }));

  const pillar = useMemo(() => pillars.find((p) => p.id === f.pillarId) ?? null, [pillars, f.pillarId]);
  const onPillar = (id: string) => {
    const p = pillars.find((x) => x.id === id);
    setF((s) => ({ ...s, pillarId: id, metricId: p?.metric?.id ?? '' }));
  };
  // When pillars load (async) and we already have an initPillarId, sync the metricId.
  useEffect(() => {
    if (initPillarId && pillars.length > 0 && !f.metricId) {
      const p = pillars.find((x) => x.id === initPillarId);
      if (p?.metric?.id) setF((s) => ({ ...s, metricId: p.metric!.id }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pillars, initPillarId]);

  /** POST to /api/strategy/pillars, refresh the dropdown, preselect the new pillar. */
  const createPillar = async () => {
    if (!np.name.trim() || npBusy) return;
    setNpErr('');
    setNpBusy(true);
    try {
      const domain = userDomains[0] ?? 'platform';
      const res = (await api('/api/strategy/pillars', 'POST', {
        name: np.name.trim(),
        description: np.description.trim() || undefined,
        scope: 'domain',
        domain,
      })) as { item: { id: string; name: string; scope: string } };
      const created: Pillar = { id: res.item.id, name: res.item.name, scope: res.item.scope, metric: null };
      setPillars((prev) => [...prev, created]);
      onPillar(created.id);
      setShowNewPillar(false);
      setNp({ ...EMPTY_PILLAR });
    } catch (e) {
      setNpErr((e as Error).message);
    } finally {
      setNpBusy(false);
    }
  };

  // A pillar is required: a bet's tier and value spine are derived from its pillar.
  const valid = !!f.pillarId;

  const submit = async () => {
    if (!valid || busy) return;
    setErr('');
    setBusy(true);
    try {
      const res = (await api('/api/big-bets', 'POST', {
        owner: f.owner,
        problem: f.problem,
        solution: f.solution,
        pillarId: f.pillarId, // required — form is disabled until set
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
    <div className="card" style={{ marginTop: 20, maxWidth: 680 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 650 }}>New Big Bet</h2>
        <button className="btn ghost sm" onClick={onClose} aria-label="Cancel" disabled={busy}>Cancel</button>
      </div>

      <Field label="Owner">
        <input
          type="text"
          value={f.owner}
          onChange={(e) => set('owner', e.target.value)}
          placeholder="e.g. Retention team"
        />
      </Field>

      <Field label="Strategic Pillar" required>
        {pillar ? (
          <div className="bb-pillar-chip">
            <span className="bb-pillar-chip-name">{pillar.name}</span>
            {pillar.metric ? <span className="bb-pillar-chip-metric">→ {pillar.metric.name}</span> : null}
            {/* Lock the pillar when pre-filled from the Strategy tab (initPillarId set). */}
            {!initPillarId ? (
              <button type="button" className="bb-pillar-chip-edit" onClick={() => onPillar('')}>Edit</button>
            ) : null}
          </div>
        ) : (
          <>
            <p className="muted" style={{ margin: '0 0 6px', fontSize: 11.5 }}>
              Every bet must sit under a pillar — the pillar drives its tier (My · Domain · Company)
              and value spine.
            </p>
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
            {/* Inline pillar creation — builders/admins get a form; creators get a calm hint */}
            {canCreatePillar ? (
              showNewPillar ? (
                <div style={{ marginTop: 10, padding: '12px 14px', background: 'var(--bg-input)', borderRadius: 8, border: '1px solid var(--border)' }}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>New pillar</span>
                    <button type="button" className="btn ghost sm" style={{ fontSize: 11 }} onClick={() => { setShowNewPillar(false); setNpErr(''); setNp({ ...EMPTY_PILLAR }); }}>
                      Cancel
                    </button>
                  </div>
                  <input
                    type="text"
                    value={np.name}
                    onChange={(e) => setNpField('name', e.target.value)}
                    placeholder="Pillar name"
                    style={{ width: '100%', marginBottom: 8 }}
                    autoFocus
                  />
                  <input
                    type="text"
                    value={np.description}
                    onChange={(e) => setNpField('description', e.target.value)}
                    placeholder="One-line description (optional)"
                    style={{ width: '100%', marginBottom: 8 }}
                  />
                  {npErr ? <div className="error" style={{ marginBottom: 8, fontSize: 12 }}>{npErr}</div> : null}
                  <button
                    type="button"
                    className="btn sm"
                    onClick={createPillar}
                    disabled={!np.name.trim() || npBusy}
                    style={{ fontSize: 12 }}
                  >
                    {npBusy ? <span className="spin" /> : 'Add pillar'}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn ghost sm"
                  style={{ marginTop: 6, fontSize: 12 }}
                  onClick={() => setShowNewPillar(true)}
                >
                  + New pillar
                </button>
              )
            ) : pillars.length === 0 ? (
              <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                No pillars yet — ask a Builder to add a strategy pillar before creating this bet.
              </p>
            ) : null}
          </>
        )}
      </Field>

      <Field label="Problem Statement">
        <textarea
          value={f.problem}
          rows={3}
          onChange={(e) => set('problem', e.target.value)}
          placeholder="e.g. Sales reps spend 3 hours/week manually updating CRM — costing $400k/year in lost selling time. (Optional — you can add this later.)"
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

      <div className="row" style={{ marginTop: 24, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={submit} disabled={!valid || busy}>
          {busy ? <span className="spin" /> : 'Create Big Bet'}
        </button>
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
