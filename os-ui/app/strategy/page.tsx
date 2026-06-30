/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import PageHeader from '@/components/PageHeader';
import { euro } from '@/lib/strategy/model';
import {
  FOUNDATION_TYPES,
  FOUNDATION_LABEL,
  type FoundationType,
} from '@/lib/strategy/scorecard-core';
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
export default function StrategyPage() {
  const [resp, setResp] = useState<ListResp | null>(null);
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<{ card: PillarCard; bet: DBet } | null>(null);

  const reload = useCallback(async () => {
    setError('');
    try {
      const [pr, sr] = await Promise.all([
        fetch('/api/strategy/pillars', { cache: 'no-store' }),
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
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const canCreate = Boolean(resp?.canCreateTenant || resp?.canCreateDomain);

  return (
    <>
      <PageHeader title="Strategy" crumb="where this company invests in its agentic transformation" />
      <div className="content strat-page">
        {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}
        {loading && !resp ? <div className="stub-page" style={{ marginTop: 20 }}>Loading strategy…</div> : null}

        {/* 1 — Big Bets (the pillars centerpiece) */}
        {resp ? (
          <section className="strat-section">
            <div className="strat-section-head">
              <h2 className="strat-section-title">Big Bets</h2>
              <p className="strat-section-sub">
                Your strategic pillars and the big bets that deliver each one&apos;s business value.
              </p>
            </div>
            {resp.items.length === 0 && !canCreate ? (
              <div className="stub-page">
                No strategic pillars yet. A Builder (domain) or Admin (company) defines the first one.
              </div>
            ) : (
              <div className="strat-pillars">
                {resp.items.map((card) => (
                  <PillarColumn
                    key={card.pillar.id}
                    card={card}
                    onChanged={reload}
                    onOpenBet={(bet) => setOpen({ card, bet })}
                  />
                ))}
                {canCreate ? <NewPillarColumn resp={resp} onCreated={reload} /> : null}
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
    </>
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

function PillarColumn({
  card,
  onChanged,
  onOpenBet,
}: {
  card: PillarCard;
  onChanged: () => void;
  onOpenBet: (bet: DBet) => void;
}) {
  const { pillar, rollup, canEdit } = card;
  const [editing, setEditing] = useState(false);

  const scopeLabel = pillar.scope === 'tenant' ? 'company' : pillar.domain;

  return (
    <section className="strat-pillar">
      <div className="strat-pillar-top">
        <span className={`badge ${pillar.scope === 'tenant' ? 'ok' : 'muted'}`}>{scopeLabel}</span>
        {canEdit ? (
          <button className="strat-icon-btn" onClick={() => setEditing((v) => !v)} aria-label="Edit pillar">
            {editing ? '×' : '✎'}
          </button>
        ) : null}
      </div>

      {editing ? (
        <EditPillar card={card} onDone={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <h2 className="strat-pillar-name">{pillar.name}</h2>
          {pillar.description ? <p className="strat-pillar-desc">{pillar.description}</p> : null}

          <div className="strat-pillar-value">
            <span className="strat-pillar-amount">{euro(rollup.total)}</span>
            <span className="strat-pillar-metric">{rollup.metricTitle}</span>
          </div>

          <ValueMetricBlock card={card} onChanged={onChanged} />

          <div className="strat-bets">
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
        </>
      )}
    </section>
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
    <div className="strat-vm">
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
  const del = async () => {
    if (!confirm(`Delete pillar "${pillar.name}"?`)) return;
    setBusy(true); setErr('');
    try { await api(`/api/strategy/pillars/${pillar.id}`, 'DELETE'); onDone(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <div className="strat-edit">
      <input className="strat-edit-title" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pillar name" />
      <textarea value={description} rows={2} onChange={(e) => setDescription(e.target.value)} placeholder="Strategic intent (business terms)" />
      <span className="muted" style={{ fontSize: 11, fontWeight: 600 }}>Value metric</span>
      <input value={vmName} onChange={(e) => setVmName(e.target.value)} placeholder="e.g. Net Revenue Retention" />
      <textarea value={vmDesc} rows={2} onChange={(e) => setVmDesc(e.target.value)} placeholder="What this value measures" />
      {err ? <div className="error" style={{ fontSize: 11.5 }}>{err}</div> : null}
      <div className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
        <button className="btn ghost sm" onClick={del} disabled={busy} style={{ color: 'var(--danger)' }}>Delete</button>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn ghost sm" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn sm" onClick={save} disabled={busy || !name.trim()}>Save</button>
        </div>
      </div>
    </div>
  );
}

function LinkBet({ pillarId, linkedIds, onChanged }: { pillarId: string; linkedIds: string[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [cat, setCat] = useState<{ id: string; name: string; domain: string }[]>([]);
  const [busy, setBusy] = useState('');

  const load = async () => {
    setOpen(true);
    try { const j = (await api('/api/strategy/catalogue', 'GET')) as { bets?: { id: string; name: string; domain: string }[] }; setCat(j.bets ?? []); }
    catch { /* offline */ }
  };
  const toggle = async (betId: string, on: boolean) => {
    setBusy(betId);
    try {
      await api(`/api/strategy/pillars/${pillarId}/bets${on ? `?betId=${betId}` : ''}`, on ? 'DELETE' : 'POST', on ? undefined : { betId });
      onChanged();
    } catch { /* surfaced on reload */ } finally { setBusy(''); }
  };

  if (!open) {
    return <button className="strat-add-bet" onClick={load}>+ Link a big bet</button>;
  }
  return (
    <div className="strat-link-bet">
      {cat.length === 0 ? <span className="muted" style={{ fontSize: 11.5 }}>No bets available to link.</span> : null}
      {cat.map((b) => {
        const on = linkedIds.includes(b.id);
        return (
          <button key={b.id} className={`strat-link-bet-opt${on ? ' on' : ''}`} disabled={busy === b.id} onClick={() => toggle(b.id, on)}>
            {on ? '✓ ' : '+ '}{b.name} <span className="muted">{b.domain}</span>
          </button>
        );
      })}
      <button className="btn ghost sm" onClick={() => setOpen(false)}>Done</button>
    </div>
  );
}

function NewPillarColumn({ resp, onCreated }: { resp: ListResp; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<'tenant' | 'domain'>(resp.canCreateTenant ? 'tenant' : 'domain');
  const [domain, setDomain] = useState(resp.user.domains[0] ?? '');
  const [vmName, setVmName] = useState('');
  const [vmDesc, setVmDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const create = async () => {
    setBusy(true); setErr('');
    try {
      await api('/api/strategy/pillars', 'POST', {
        name, description, scope,
        domain: scope === 'domain' ? domain : undefined,
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
      <button className="strat-pillar strat-pillar-new" onClick={() => setOpen(true)}>
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
        <span className="muted" style={{ fontSize: 11, fontWeight: 600 }}>Scope</span>
        <div className="rt-seg">
          {resp.canCreateTenant ? (
            <button className={`rt-seg-opt${scope === 'tenant' ? ' active' : ''}`} onClick={() => setScope('tenant')}>Company</button>
          ) : null}
          <button className={`rt-seg-opt${scope === 'domain' ? ' active' : ''}`} onClick={() => setScope('domain')}>Domain</button>
        </div>
        {scope === 'domain' ? (
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

