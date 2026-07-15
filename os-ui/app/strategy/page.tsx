/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import PageHeader from '@/components/PageHeader';
import { anchorAttr, ANCHORS } from '@/lib/tutorials/anchors';
import {
  euro,
  formatMetricValue,
  trendFor,
  yearFraction,
  METRIC_TYPES,
  METRIC_TYPE_LABEL,
  HORIZONS,
  HORIZON_LABEL,
  type MetricType,
  type Horizon,
} from '@/lib/strategy/model';
import {
  FOUNDATION_TYPES,
  FOUNDATION_LABEL,
  type FoundationType,
} from '@/lib/strategy/scorecard-core';
import {
  PILLAR_SCOPES,
  PILLAR_SCOPE_LABEL,
  type PillarScope,
} from '@/lib/strategy/model';
import { useTileOrder } from '@/lib/prefs/useTileOrder';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import BetDetail from './BetDetail';
import ValueChart from './ValueChart';
import {
  api,
  statusCounts,
  type ListResp,
  type PillarCard,
  type DBet,
} from './types';

/** Client mirror of the /api/strategy/scorecard response (server reduces it). */
type Scorecard = {
  scopeLabel: string;
  selfService: {
    totalUsers: number;
    analytics: number;
    ai: number;
    software: number;
    builders: number;
    creators: number;
  };
  foundations: Record<FoundationType, number>;
};

/**
 * Strategy — exactly three sections, top to bottom:
 *
 *   1. Big Bets   — the strategic pillars, side by side. Each pillar realizes a
 *                   business value, delivered by its big bets. Create/edit inline.
 *   2. Self Service — how broadly the platform is adopted: distinct people who
 *                   have created in each capability area, plus the builder/creator
 *                   population. Scoped to the viewer's company/domain (RLS).
 *   3. Foundations — the governed asset base: promoted + certified artifacts by
 *                   type, the certified backbone every bet builds on.
 *
 * Nothing else. Calm, Apple-grade; governance stays server-side.
 */
// Stable references for useTileOrder (memoization holds across renders).
const NO_CARDS: PillarCard[] = [];
const pillarIdOf = (card: PillarCard) => card.pillar.id;

/** The three strategy tiers, shown as a segment switcher (+ "All"). */
type TierKey = 'all' | PillarScope;
const TIER_SEG: { key: TierKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'personal', label: PILLAR_SCOPE_LABEL.personal }, // My
  { key: 'domain', label: PILLAR_SCOPE_LABEL.domain },
  { key: 'tenant', label: PILLAR_SCOPE_LABEL.tenant }, // Company
];

export default function StrategyPage() {
  const [resp, setResp] = useState<ListResp | null>(null);
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<{ card: PillarCard; bet: DBet } | null>(null);
  // Strategy tier segment (My · Domain · Company) + archived affordance.
  const [tier, setTier] = useState<TierKey>('all');
  const [showArchived, setShowArchived] = useState(false);

  const reload = useCallback(async () => {
    setError('');
    try {
      const [pr, sr] = await Promise.all([
        fetch(`/api/strategy/pillars${showArchived ? '?archived=1' : ''}`, { cache: 'no-store' }),
        fetch('/api/strategy/scorecard', { cache: 'no-store' }),
      ]);
      const pj = await pr.json();
      if (!pr.ok) throw new Error(pj.error ?? 'Failed to load pillars');
      setResp(pj as ListResp);
      const sj = await sr.json();
      setScorecard(sr.ok ? (sj as Scorecard) : null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [showArchived]);

  useEffect(() => { reload(); }, [reload]);

  const canCreate = Boolean(resp?.canCreatePersonal || resp?.canCreateTenant || resp?.canCreateDomain);

  // Tile-order drag — everyone can arrange their own pillar view.
  const { orderedItems: orderedCards, itemDragProps, dragHandleProps } = useTileOrder(
    'strategy.pillars',
    resp?.items ?? NO_CARDS,
    pillarIdOf,
  );

  // Per-tier counts (active only) for the segment labels.
  const tierCount = useCallback(
    (k: TierKey) => orderedCards.filter((c) => !c.pillar.archived && (k === 'all' || c.pillar.scope === k)).length,
    [orderedCards],
  );
  // The cards shown for the selected tier (My/Domain/Company grouping).
  const shownCards = orderedCards.filter((c) => tier === 'all' || c.pillar.scope === tier);

  return (
    <ConfirmProvider>
      <PageHeader title="Strategy" crumb="where this company invests in its agentic transformation" tutorial="strategy" />
      <div className="content strat-page">
        {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}
        {loading && !resp ? <div className="stub-page" style={{ marginTop: 20 }}>Loading strategy…</div> : null}

        {/* 1 — Big Bets (the pillars centerpiece) */}
        {resp ? (
          <section className="strat-section" {...anchorAttr(ANCHORS.strategy.sandbox)}>
            <div className="strat-section-head">
              <h2 className="strat-section-title">Strategic Pillars</h2>
              <p className="strat-section-sub">
                Your strategic priorities and the big bets that deliver each one&apos;s value.
              </p>
            </div>

            {/* Tier switcher — My · Domain · Company (+ All). The strategy analogue
                of the OS-wide scope segment; no Marketplace here. */}
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div className="seg">
                {TIER_SEG.map((t) => (
                  <button key={t.key} type="button" className={tier === t.key ? 'on' : ''} onClick={() => setTier(t.key)}>
                    {t.label}{t.key !== 'all' ? ` (${tierCount(t.key)})` : ''}
                  </button>
                ))}
              </div>
              <button
                className="btn ghost sm"
                style={{ opacity: showArchived ? 1 : 0.7 }}
                onClick={() => setShowArchived((s) => !s)}
                title="Archived pillars are hidden by default"
              >
                {showArchived ? 'Hide archived' : 'Show archived'}
              </button>
            </div>

            {resp.items.length === 0 && !canCreate ? (
              <div className="stub-page">
                No strategic pillars yet. Anyone can define a My pillar; a Builder (domain) or Admin (company) defines shared ones.
              </div>
            ) : (
              <div className="strat-pillars" style={{ marginTop: 14 }}>
                {shownCards.map((card) => (
                  <PillarColumn
                    key={card.pillar.id}
                    card={card}
                    currency={resp.currency}
                    onChanged={reload}
                    onOpenBet={(bet) => setOpen({ card, bet })}
                    dragProps={itemDragProps(card)}
                    dragHandleProps={dragHandleProps}
                  />
                ))}
                {canCreate ? <NewPillarColumn resp={resp} initialTier={tier} onCreated={reload} /> : null}
              </div>
            )}
          </section>
        ) : null}

        {/* 2 — Self Service */}
        {scorecard ? <SelfServiceSection sc={scorecard} /> : null}

        {/* 3 — Foundations */}
        {scorecard ? <FoundationsSection sc={scorecard} /> : null}
      </div>

      {open ? <BetDetail card={open.card} bet={open.bet} onClose={() => setOpen(null)} /> : null}
    </ConfirmProvider>
  );
}

/* ------------------------------------------------------- Self Service ---------- */

function SelfServiceSection({ sc }: { sc: Scorecard }) {
  const s = sc.selfService;
  const tiles: { label: string; value: number; hint: string; accent?: boolean }[] = [
    { label: 'Total Users', value: s.totalUsers, hint: 'people in scope', accent: true },
    { label: 'Analytics', value: s.analytics, hint: 'created a dashboard, data product or metric' },
    { label: 'AI', value: s.ai, hint: 'created an agent or ML model' },
    { label: 'Software', value: s.software, hint: 'created a software app' },
    { label: 'Builders', value: s.builders, hint: 'builder-role members' },
    { label: 'Creators', value: s.creators, hint: 'creator-role members' },
  ];
  const anyAdoption = s.analytics + s.ai + s.software > 0;
  return (
    <section className="strat-section">
      <div className="strat-section-head">
        <h2 className="strat-section-title">Self Service</h2>
        <p className="strat-section-sub">
          How broadly your people build for themselves — distinct creators by area, across {sc.scopeLabel}.
        </p>
      </div>
      <div className="strat-stat-grid">
        {tiles.map((t) => (
          <div key={t.label} className={`strat-stat-tile${t.accent ? ' accent' : ''}`}>
            <span className="strat-stat-value">{t.value}</span>
            <span className="strat-stat-label">{t.label}</span>
            <span className="strat-stat-hint">{t.hint}</span>
          </div>
        ))}
      </div>
      {!anyAdoption ? (
        <p className="strat-section-empty">
          No self-service activity yet — counts grow as people create dashboards, data, metrics, agents,
          models and apps in their own tabs.
        </p>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------- Foundations ---------- */

function FoundationsSection({ sc }: { sc: Scorecard }) {
  const total = FOUNDATION_TYPES.reduce((n, t) => n + (sc.foundations[t] ?? 0), 0);
  return (
    <section className="strat-section">
      <div className="strat-section-head">
        <h2 className="strat-section-title">Foundations</h2>
        <p className="strat-section-sub">
          The governed asset base across {sc.scopeLabel} — promoted and certified artifacts by type.
        </p>
      </div>
      <div className="strat-found-grid">
        {FOUNDATION_TYPES.map((t) => (
          <div key={t} className="strat-found-tile">
            <span className="strat-found-value">{sc.foundations[t] ?? 0}</span>
            <span className="strat-found-label">{FOUNDATION_LABEL[t]}</span>
          </div>
        ))}
      </div>
      {total === 0 ? (
        <p className="strat-section-empty">
          No promoted or certified foundations yet — promote an artifact to Shared or certify it to the
          Marketplace and it counts here.
        </p>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ Pillar ---- */

type DragHandleProps = { onMouseDown: (e: React.MouseEvent) => void };
type ItemDragProps = ReturnType<ReturnType<typeof useTileOrder>['itemDragProps']>;

function PillarColumn({
  card,
  currency,
  onChanged,
  onOpenBet,
  dragProps,
  dragHandleProps,
}: {
  card: PillarCard;
  currency: string;
  onChanged: () => void;
  onOpenBet: (bet: DBet) => void;
  dragProps?: ItemDragProps;
  dragHandleProps?: DragHandleProps;
}) {
  const { pillar, rollup, canEdit, canPromote, promoteTo } = card;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Tier badge — My · Domain (its domain) · Company.
  const scopeLabel =
    pillar.scope === 'tenant' ? 'Company' : pillar.scope === 'personal' ? 'My' : pillar.domain;
  const archived = !!pillar.archived;

  const promote = async () => {
    if (!promoteTo) return;
    setBusy(true); setErr('');
    try { await api(`/api/strategy/pillars/${pillar.id}`, 'POST', { action: 'promote' }); onChanged(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <section className="strat-pillar" style={{ opacity: archived ? 0.62 : 1 }} {...(dragProps ?? {})}>
      <div className="strat-pillar-top">
        <span className={`badge ${pillar.scope === 'tenant' ? 'ok' : pillar.scope === 'domain' ? 'muted' : ''}`}>{scopeLabel}</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {archived ? <span className="chip">archived</span> : null}
          {dragHandleProps ? (
            <span
              className="drag-handle"
              title="Drag to reorder"
              aria-label="Drag to reorder"
              {...dragHandleProps}
            >
              ⋮⋮
            </span>
          ) : null}
          {canEdit ? (
            <button className="strat-icon-btn" onClick={() => setEditing((v) => !v)} aria-label="Edit pillar">
              {editing ? '×' : '✎'}
            </button>
          ) : null}
        </div>
      </div>

      {editing ? (
        <EditPillar card={card} onDone={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <h2 className="strat-pillar-name">{pillar.name}</h2>
          {pillar.description ? <p className="strat-pillar-desc">{pillar.description}</p> : null}

          <HeadlineTarget card={card} currency={currency} onChanged={onChanged} />

          <ValueMetricBlock card={card} onChanged={onChanged} />

          <div className="strat-bets" {...anchorAttr(ANCHORS.strategy.bets)}>
            {rollup.bets.length === 0 ? (
              <div className="hint" style={{ margin: 0 }}>
                No big bets linked yet.{canEdit ? ' Link one below to start delivering this pillar.' : ''}
              </div>
            ) : (
              rollup.bets.map((bet) => {
                const counts = statusCounts(bet.components);
                return (
                  <button key={bet.id} className="strat-bet-box" onClick={() => onOpenBet(bet)}>
                    <div className="strat-bet-row">
                      <span className="strat-bet-name">{bet.name}</span>
                      <span className="strat-bet-value mono">{bet.entitled ? euro(bet.value) : '🔒'}</span>
                    </div>
                    <div className="strat-bet-meta">
                      <span className="badge muted">{bet.domain}</span>
                      <span className="muted">
                        {counts.ready} ready · {counts['in-progress']} in progress · {counts.planned} planned
                      </span>
                    </div>
                    <span className="strat-bet-cta">View details →</span>
                  </button>
                );
              })
            )}
          </div>

          {canEdit ? <LinkBet pillarId={pillar.id} linkedIds={pillar.betIds} onChanged={onChanged} /> : null}

          {card.audit.length > 0 ? (
            <p className="strat-pillar-audit">
              Last edit: {card.audit[0].action} · {card.audit[0].actor} · {new Date(card.audit[0].at).toLocaleDateString()}
            </p>
          ) : null}

          {/* Promote one tier up (My→Domain→Company), role-gated server-side. */}
          {canPromote && promoteTo && !archived ? (
            <button className="btn ghost sm" style={{ marginTop: 8 }} disabled={busy} onClick={promote}>
              {busy ? <span className="spin" /> : `Promote to ${PILLAR_SCOPE_LABEL[promoteTo]} →`}
            </button>
          ) : null}
          {err ? <div className="error" style={{ fontSize: 11.5, marginTop: 6 }}>{err}</div> : null}

          {/* Lifecycle: archive → restore / delete + version history, via the
              SAME shared cluster every OS tab uses. Only for editors. */}
          {canEdit ? (
            <div className="strat-pillar-lifecycle" style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <LifecycleActions
                id={pillar.id}
                name={pillar.name}
                kind="pillar"
                visibility={pillar.scope === 'personal' ? 'personal' : 'shared'}
                archived={archived}
                api={`/api/strategy/pillars/${pillar.id}`}
                onChanged={onChanged}
                compact
                surface="detail"
              />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/* --------------------------------------------------------- Headline target ---- */

/** Compact "27 Jun 2026" for the horizon end date. */
function fmtEnd(iso: string): string {
  const t = Date.parse(iso.length === 10 ? iso + 'T00:00:00Z' : iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * The pillar card's centerpiece: the BIG target number (formatted per the metric
 * type + tenant currency) with its horizon end date, and directly beneath a
 * smaller "so far" = the latest reported/achieved value, plus a subtle on-track /
 * behind cue derived from the existing trend pacing.
 */
function HeadlineTarget({ card, currency, onChanged }: { card: PillarCard; currency: string; onChanged: () => void }) {
  const { pillar, rollup, canEdit } = card;
  const [editing, setEditing] = useState(false);
  const target = pillar.headlineTarget;
  const vm = pillar.valueMetric;
  const achieved = rollup.total; // latest reported/governed/manual value (the value spine)

  if (editing) {
    return <TargetEditor card={card} onDone={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />;
  }

  if (!target) {
    return (
      <div className="strat-pillar-value" {...anchorAttr(ANCHORS.strategy.rollup)}>
        {canEdit ? (
          <button className="strat-target-set" onClick={() => setEditing(true)}>+ Set a target</button>
        ) : (
          <>
            <span className="strat-pillar-amount">{formatMetricValue(achieved, vm, currency)}</span>
            <span className="strat-pillar-metric">{rollup.metricTitle}</span>
          </>
        )}
      </div>
    );
  }

  // On-track cue: pace the achieved value against the target over the horizon
  // (year-end uses the elapsed calendar year; other horizons pace over their span).
  const trend = target.value > 0
    ? trendFor(achieved, target.value, horizonFraction(target.horizon, target.setAt, target.endDate))
    : 'no-target';
  const cue = trend === 'on-track' ? 'ok' : trend === 'behind' ? 'warn' : 'muted';
  const cueLabel = trend === 'on-track' ? 'On track' : trend === 'behind' ? 'Behind' : '';

  return (
    <div className="strat-pillar-value" {...anchorAttr(ANCHORS.strategy.rollup)}>
      <div className="strat-target-head">
        <span className="strat-pillar-amount">{formatMetricValue(target.value, vm, currency)}</span>
        {canEdit ? (
          <button className="strat-icon-btn" onClick={() => setEditing(true)} aria-label="Edit target">✎</button>
        ) : null}
      </div>
      <span className="strat-pillar-metric">
        {rollup.metricTitle} · {HORIZON_LABEL[target.horizon]} target by {fmtEnd(target.endDate)}
      </span>
      <div className="strat-target-sofar">
        <span className="strat-target-sofar-val">so far: {formatMetricValue(achieved, vm, currency)}</span>
        {cueLabel ? <span className={`badge ${cue}`}>{cueLabel}</span> : null}
      </div>
    </div>
  );
}

/** Fraction of the horizon elapsed (year-end → elapsed calendar year; else span). */
function horizonFraction(horizon: Horizon, setAtIso: string, endIso: string): number {
  if (horizon === 'year-end') return yearFraction(new Date());
  const start = Date.parse(setAtIso);
  const end = Date.parse(endIso.length === 10 ? endIso + 'T00:00:00Z' : endIso);
  const now = Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
}

function TargetEditor({ card, onDone, onCancel }: { card: PillarCard; onDone: () => void; onCancel: () => void }) {
  const { pillar } = card;
  const t = pillar.headlineTarget;
  const vm = pillar.valueMetric;
  const [value, setValue] = useState(t ? String(t.value) : '');
  const [metricType, setMetricType] = useState<MetricType>(t?.metricType ?? vm?.metricType ?? 'ebit');
  const [horizon, setHorizon] = useState<Horizon>(t?.horizon ?? 'year-end');
  const [customUnit, setCustomUnit] = useState(vm?.customUnit ?? '');
  const [customMonetary, setCustomMonetary] = useState(Boolean(vm?.customMonetary));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    const n = Number(value);
    if (!Number.isFinite(n)) { setErr('Enter a number'); return; }
    setBusy(true); setErr('');
    try {
      // Custom metric: persist the unit label + monetary flag on the value metric first.
      if (metricType === 'custom') {
        await api(`/api/strategy/pillars/${pillar.id}/value-metric`, 'PUT', {
          metricType: 'custom', customUnit, customMonetary,
        });
      }
      await api(`/api/strategy/pillars/${pillar.id}/target`, 'PUT', { value: n, metricType, horizon });
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <div className="strat-target-edit">
      <span className="muted" style={{ fontSize: 11, fontWeight: 600 }}>What does this pillar measure?</span>
      <select value={metricType} onChange={(e) => setMetricType(e.target.value as MetricType)}>
        {METRIC_TYPES.map((m) => <option key={m} value={m}>{METRIC_TYPE_LABEL[m]}</option>)}
      </select>
      {metricType === 'custom' ? (
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input style={{ flex: '1 1 auto' }} value={customUnit} onChange={(e) => setCustomUnit(e.target.value)} placeholder="Unit label (e.g. tickets)" disabled={customMonetary} />
          <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11.5 }}>
            <input type="checkbox" checked={customMonetary} onChange={(e) => setCustomMonetary(e.target.checked)} /> monetary
          </label>
        </div>
      ) : null}
      <span className="muted" style={{ fontSize: 11, fontWeight: 600 }}>Target value</span>
      <input type="number" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 2500000" />
      <span className="muted" style={{ fontSize: 11, fontWeight: 600 }}>Horizon</span>
      <div className="rt-seg">
        {HORIZONS.map((h) => (
          <button key={h} className={`rt-seg-opt${horizon === h ? ' active' : ''}`} onClick={() => setHorizon(h)}>
            {HORIZON_LABEL[h]}
          </button>
        ))}
      </div>
      {err ? <div className="error" style={{ fontSize: 11.5 }}>{err}</div> : null}
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn ghost sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn sm" onClick={save} disabled={busy || !value.trim()}>Save target</button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- Value metric block - */

function ValueMetricBlock({ card, onChanged }: { card: PillarCard; onChanged: () => void }) {
  const { pillar, rollup, canEdit, history } = card;
  const router = useRouter();
  const mode = rollup.mode;
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const setMode = async (next: 'manual' | 'governed') => {
    setBusy(true); setErr('');
    try { await api(`/api/strategy/pillars/${pillar.id}/value-metric`, 'PUT', { mode: next }); onChanged(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  // Mark the metric governed, THEN hand off to the Metrics create flow (so the
  // mode persists even though we navigate away).
  const goGoverned = async () => {
    await setMode('governed');
    router.push(`/metrics?pillar=${encodeURIComponent(pillar.id)}`);
  };
  const addEntry = async () => {
    const n = Number(val);
    if (!Number.isFinite(n)) { setErr('Enter a number'); return; }
    setBusy(true); setErr('');
    try { await api(`/api/strategy/pillars/${pillar.id}/value-entry`, 'POST', { value: n }); setVal(''); onChanged(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="strat-vm" {...anchorAttr(ANCHORS.strategy.value)}>
      {rollup.metricDescription ? <p className="strat-vm-desc">{rollup.metricDescription}</p> : null}

      {mode === 'manual' ? (
        <>
          <ValueChart points={history} height={96} />
          {canEdit ? (
            <div className="strat-vm-entry">
              <input
                type="number"
                inputMode="decimal"
                placeholder="This month's value"
                value={val}
                onChange={(e) => setVal(e.target.value)}
                disabled={busy}
              />
              <button className="btn sm" onClick={addEntry} disabled={busy || !val}>Save</button>
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 11.5, margin: 0 }}>Tracked manually each month.</p>
          )}
        </>
      ) : mode === 'governed' ? (
        <p className="strat-vm-mode">
          <span className="badge ok">governed</span>{' '}
          <span className="muted">value flows from a Cube metric.</span>{' '}
          <Link href="/metrics" className="strat-link">Open in Metrics →</Link>
        </p>
      ) : (
        canEdit ? (
          <div className="strat-vm-choose">
            <span className="muted" style={{ fontSize: 11.5 }}>How should this value be kept?</span>
            <div className="strat-vm-choose-btns">
              <button className="btn ghost sm" onClick={goGoverned} disabled={busy}>
                Set up a governed metric
              </button>
              <button className="btn ghost sm" onClick={() => setMode('manual')} disabled={busy}>
                Track manually
              </button>
            </div>
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 11.5, margin: 0 }}>Value metric not set up yet.</p>
        )
      )}
      {err ? <div className="error" style={{ fontSize: 11.5 }}>{err}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------- Inline editors - */

function EditPillar({ card, onDone, onCancel }: { card: PillarCard; onDone: () => void; onCancel: () => void }) {
  const { pillar } = card;
  const [name, setName] = useState(pillar.name);
  const [description, setDescription] = useState(pillar.description);
  const [vmName, setVmName] = useState(pillar.valueMetric?.name ?? card.rollup.metricTitle ?? '');
  const [vmDesc, setVmDesc] = useState(pillar.valueMetric?.description ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setBusy(true); setErr('');
    try {
      await api(`/api/strategy/pillars/${pillar.id}`, 'PATCH', { name, description });
      await api(`/api/strategy/pillars/${pillar.id}/value-metric`, 'PUT', { name: vmName, description: vmDesc });
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <div className="strat-edit">
      <input className="strat-edit-title" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pillar name" />
      <textarea value={description} rows={2} onChange={(e) => setDescription(e.target.value)} placeholder="Strategic intent (business terms)" />
      <span className="muted" style={{ fontSize: 11, fontWeight: 600 }}>Value metric</span>
      <input value={vmName} onChange={(e) => setVmName(e.target.value)} placeholder="e.g. Net Revenue Retention" />
      <textarea value={vmDesc} rows={2} onChange={(e) => setVmDesc(e.target.value)} placeholder="What this value measures" />
      {err ? <div className="error" style={{ fontSize: 11.5 }}>{err}</div> : null}
      {/* Delete lives with the lifecycle cluster (archive first, then delete) — the
          calm-edit form just saves content. */}
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn ghost sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn sm" onClick={save} disabled={busy || !name.trim()}>Save</button>
      </div>
    </div>
  );
}

function LinkBet({ pillarId, linkedIds, onChanged }: { pillarId: string; linkedIds: string[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [cat, setCat] = useState<{ id: string; name: string; domain: string }[]>([]);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = async () => {
    setOpen(true);
    try { const j = (await api('/api/strategy/catalogue', 'GET')) as { bets?: { id: string; name: string; domain: string }[] }; setCat(j.bets ?? []); }
    catch { /* offline */ }
  };
  const toggle = async (betId: string, on: boolean) => {
    setBusy(betId); setErr('');
    try {
      await api(`/api/strategy/pillars/${pillarId}/bets${on ? `?betId=${betId}` : ''}`, on ? 'DELETE' : 'POST', on ? undefined : { betId });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); onChanged(); }
  };

  if (!open) {
    return <button className="strat-add-bet" onClick={load}>+ Link a big bet</button>;
  }
  return (
    <div className="strat-link-bet">
      {cat.length === 0 ? (
        <span className="muted" style={{ fontSize: 11.5 }}>
          No big bets yet.{' '}
          <Link href="/big-bets" style={{ color: 'var(--teal)' }}>Create one →</Link>
        </span>
      ) : null}
      {cat.map((b) => {
        const on = linkedIds.includes(b.id);
        return (
          <button key={b.id} className={`strat-link-bet-opt${on ? ' on' : ''}`} disabled={busy === b.id} onClick={() => toggle(b.id, on)}>
            {on ? '✓ ' : '+ '}{b.name} <span className="muted">{b.domain}</span>
          </button>
        );
      })}
      {err ? <div className="error" style={{ fontSize: 11.5 }}>{err}</div> : null}
      <button className="btn ghost sm" onClick={() => setOpen(false)}>Done</button>
    </div>
  );
}

function NewPillarColumn({ resp, initialTier, onCreated }: { resp: ListResp; initialTier: TierKey; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // Default the new-pillar scope to the currently-viewed tier when the caller may
  // create it there, else the highest tier they can create.
  const defaultScope: PillarScope =
    initialTier !== 'all' && (
      (initialTier === 'tenant' && resp.canCreateTenant) ||
      (initialTier === 'domain' && resp.canCreateDomain) ||
      (initialTier === 'personal' && resp.canCreatePersonal)
    )
      ? initialTier
      : resp.canCreateTenant ? 'tenant' : resp.canCreateDomain ? 'domain' : 'personal';
  const [scope, setScope] = useState<PillarScope>(defaultScope);
  const [domain, setDomain] = useState(resp.user.domains[0] ?? '');
  const [vmName, setVmName] = useState('');
  const [vmDesc, setVmDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const create = async () => {
    if ((scope === 'domain' || scope === 'personal') && !domain.trim()) { setErr('No domain available'); return; }
    setBusy(true); setErr('');
    try {
      await api('/api/strategy/pillars', 'POST', {
        name, description, scope,
        // tenant → server uses literal 'tenant'; domain/personal carry a home domain.
        domain: scope === 'tenant' ? undefined : domain,
        valueMetric: vmName || vmDesc ? { name: vmName, description: vmDesc } : undefined,
      });
      setOpen(false); setName(''); setDescription(''); setVmName(''); setVmDesc('');
      onCreated();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
    finally { setBusy(false); }
  };

  if (!open) {
    const first = resp.items.length === 0;
    return (
      <button className="strat-pillar strat-pillar-new" onClick={() => setOpen(true)} {...anchorAttr(ANCHORS.strategy.create)}>
        <span className="strat-new-plus">+</span>
        <span className="strat-new-label">{first ? 'Create your first pillar' : 'New pillar'}</span>
        <span className="muted" style={{ fontSize: 11.5 }}>Define a strategic priority</span>
      </button>
    );
  }

  return (
    <section className="strat-pillar strat-edit-col">
      <div className="strat-edit">
        <input className="strat-edit-title" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pillar name (e.g. Retention)" />
        <textarea value={description} rows={2} onChange={(e) => setDescription(e.target.value)} placeholder="Strategic intent (business terms)" />
        <span className="muted" style={{ fontSize: 11, fontWeight: 600 }}>Tier</span>
        <div className="rt-seg">
          {resp.canCreatePersonal ? (
            <button className={`rt-seg-opt${scope === 'personal' ? ' active' : ''}`} onClick={() => setScope('personal')}>My</button>
          ) : null}
          {resp.canCreateDomain ? (
            <button className={`rt-seg-opt${scope === 'domain' ? ' active' : ''}`} onClick={() => setScope('domain')}>Domain</button>
          ) : null}
          {resp.canCreateTenant ? (
            <button className={`rt-seg-opt${scope === 'tenant' ? ' active' : ''}`} onClick={() => setScope('tenant')}>Company</button>
          ) : null}
        </div>
        {(scope === 'domain' || scope === 'personal') && resp.user.domains.length > 0 ? (
          <select value={domain} onChange={(e) => setDomain(e.target.value)}>
            {resp.user.domains.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        ) : null}
        <span className="muted" style={{ fontSize: 11, fontWeight: 600 }}>Value metric (describe it)</span>
        <input value={vmName} onChange={(e) => setVmName(e.target.value)} placeholder="e.g. Net Revenue Retention" />
        <textarea value={vmDesc} rows={2} onChange={(e) => setVmDesc(e.target.value)} placeholder="What this value measures" />
        {err ? <div className="error" style={{ fontSize: 11.5 }}>{err}</div> : null}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn ghost sm" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
          <button className="btn sm" onClick={create} disabled={busy || !name.trim()}>Create pillar</button>
        </div>
      </div>
    </section>
  );
}
