/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import {
  type BetView, type ValueBasis, type AllocationMethod, eur, fmtDate, problemLine,
} from '../types';
import { ProgressBar, SignalBadge } from '../ui';
import Roadmap from './Roadmap';
import Components from './Components';
import Planner from './Planner';
import ValuePanel from './ValuePanel';
import Design from './Design';
import DomainTag from '@/components/DomainTag';

/**
 * The bet detail — consistent with Strategy's BetDetail. One column, four
 * sections in delivery order: Value → Roadmap → Components → Audit, plus an
 * Archive action. (No Composition box; the value model already shows upstream
 * credit in its distribution table.)
 */
export default function BetDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [basis, setBasis] = useState<ValueBasis | ''>('');
  const [allocation, setAllocation] = useState<AllocationMethod | ''>('');
  const [view, setView] = useState<BetView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAudit, setShowAudit] = useState(false);
  const [tab, setTab] = useState<'design' | 'value'>('design');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const qs = new URLSearchParams();
      if (basis) qs.set('basis', basis);
      if (allocation) qs.set('allocation', allocation);
      const res = await fetch(`/api/big-bets/${id}${qs.toString() ? `?${qs}` : ''}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? `Request failed (${res.status})`);
      else setView(body as BetView);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id, basis, allocation]);

  useEffect(() => { load(); }, [load]);

  return (
    <ConfirmProvider>
      <PageHeader title={view ? view.bet.name : 'Big Bet'} crumb="initiative roadmap over real components" />
      <div className="content">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Link href="/big-bets" style={{ color: 'var(--teal)', fontSize: 12.5 }}>← All big bets</Link>
        </div>

        {error ? <div className="error" style={{ marginTop: 14 }}>{error}</div> : null}
        {loading && !view ? <div className="stub-page">Loading bet…</div> : null}

        {view ? (
          <>
            <HeaderBand view={view} onMutate={load} />

            <div className="mode-toggle" style={{ marginTop: 16 }} role="tablist" aria-label="Bet view">
              <button className={tab === 'design' ? 'active' : ''} role="tab" aria-selected={tab === 'design'} onClick={() => setTab('design')}>Design</button>
              <button className={tab === 'value' ? 'active' : ''} role="tab" aria-selected={tab === 'value'} onClick={() => setTab('value')}>Value</button>
            </div>

            {tab === 'design' ? <Design view={view} onMutate={load} /> : (
            <>
            {/* 1 — Value */}
            <div className="section-title">Value</div>
            <div className="card bb-value-card">
              <ValuePanel
                view={view}
                basis={basis || view.value.realized.basis}
                allocation={allocation || view.value.distribution.allocation}
                onBasis={setBasis}
                onAllocation={setAllocation}
                canEdit={view.canEdit}
                betId={view.bet.id}
                onMutate={load}
              />
            </div>

            {/* 2 — Roadmap */}
            <div className="section-title">Roadmap</div>
            <div className="card"><Roadmap view={view} /></div>

            {/* 2.5 — Health */}
            <div className="section-title">Health</div>
            <div className="card"><BetHealth view={view} /></div>

            {/* 3 — Components (with the planner that scaffolds them) */}
            <div className="section-title">Components</div>
            <Components view={view} onMutate={load} />
            <div className="card" style={{ marginTop: 12 }}><Planner betId={view.bet.id} onMutate={load} /></div>

            {/* 4 — Audit */}
            <div className="section-title">
              Audit
              <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={() => setShowAudit((v) => !v)}>
                {showAudit ? 'Hide' : `Show (${view.audit.length})`}
              </button>
            </div>
            {showAudit ? (
              <div className="card">
                {view.audit.length === 0 ? (
                  <div className="muted">No audit entries yet.</div>
                ) : (
                  <div style={{ display: 'grid', gap: 6 }}>
                    {view.audit.map((a) => (
                      <div key={a.id} className="row" style={{ justifyContent: 'space-between', gap: 12, fontSize: 12 }}>
                        <span><strong>{a.action}</strong>{a.detail ? <span className="muted"> · {typeof a.detail === 'string' ? a.detail : JSON.stringify(a.detail)}</span> : null}</span>
                        <span className="muted mono" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{a.actor} · {fmtDate(a.at.slice(0, 10))}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
            </>
            )}

            <div className="row" style={{ marginTop: 20, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
              <div className="hint" style={{ margin: 0 }}>
                Source: <span className="mono">{view.sourceMode}</span>. The bet shows delivery;{' '}
                <Link href="/monitoring" style={{ color: 'var(--teal)' }}>Monitoring</Link> shows runtime health.
              </div>
              {view.canEdit ? (
                // OS-wide rule: live → Archive; only an ARCHIVED bet exposes Delete.
                <LifecycleActions
                  id={view.bet.id}
                  name={view.bet.name}
                  kind="bigbet"
                  visibility={view.bet.crossDomain ? 'shared' : 'personal'}
                  archived={view.bet.status === 'archived'}
                  api={`/api/big-bets/${view.bet.id}`}
                  onChanged={() => { router.push('/big-bets'); }}
                  showVersions={false}
                  compact
                />
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </ConfirmProvider>
  );
}

function HeaderBand({ view, onMutate }: { view: BetView; onMutate: () => void }) {
  const b = view.bet;
  const r = view.roadmap;
  const archived = b.status === 'archived';
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(b.name);
  const [need, setNeed] = useState(b.problem.need ?? '');
  const [solution, setSolution] = useState(b.solution ?? '');
  const [target, setTarget] = useState(String(b.targetValue));
  const [goLive, setGoLive] = useState(b.goLive);
  const [saving, setSaving] = useState(false);
  const [editErr, setEditErr] = useState('');

  const openEdit = () => {
    setName(b.name);
    setNeed(b.problem.need);
    setSolution(b.solution ?? '');
    setTarget(String(b.targetValue));
    setGoLive(b.goLive);
    setEditErr('');
    setEditing(true);
  };

  const save = async () => {
    setSaving(true); setEditErr('');
    try {
      const res = await fetch(`/api/big-bets/${b.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, problem: { ...b.problem, need }, solution, targetValue: Number(target), goLive }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
      }
      setEditing(false);
      onMutate();
    } catch (e) {
      setEditErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 280 }}>
          <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {archived ? <span className="chip">archived</span> : <SignalBadge signal={r.signal} />}
            {b.crossDomain ? <DomainTag domain={b.domain} /> : <span className="chip">{b.domain}</span>}
            {b.crossDomain ? <span className="chip">cross-domain</span> : null}
            <span className="muted" style={{ fontSize: 11.5 }}>owner {b.problem.who || b.owner}</span>
          </div>
          <p style={{ marginTop: 10, marginBottom: 0, maxWidth: 640, lineHeight: 1.55, color: 'var(--text)' }}>
            {problemLine(b.problem)}
          </p>
          {b.solution ? (
            <p className="muted" style={{ marginTop: 8, marginBottom: 0, maxWidth: 640, lineHeight: 1.55 }}>
              <span style={{ fontWeight: 600, color: 'var(--text)' }}>Solution · </span>{b.solution}
            </p>
          ) : null}
          <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
            {view.pillar ? <>pillar <strong>{view.pillar.name}</strong></> : 'no pillar'}
            {view.metric ? <> → metric <strong>{view.metric.name}</strong></> : null}
          </div>
        </div>
        <div style={{ textAlign: 'right', minWidth: 180 }}>
          <div className="big" style={{ fontSize: 24, color: 'var(--gold-light)' }}>{eur(view.value.realized.realized)}</div>
          <div className="muted" style={{ fontSize: 11.5 }}>
            realized · {view.value.realized.basis} basis
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{eur(b.targetValue)} target</div>
          {view.canEdit && !archived ? (
            <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={openEdit}>Edit bet</button>
          ) : null}
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 5 }}>
          <span className="muted" style={{ fontSize: 11.5 }}>
            Completion · {view.completion.done}/{view.completion.total} · go-live {fmtDate(b.goLive)}
            {r.goLiveRealistic ? '' : ' · date at risk'}
          </span>
          <span className="muted mono" style={{ fontSize: 11.5 }}>{view.completion.pct}%</span>
        </div>
        <ProgressBar pct={view.completion.pct} />
      </div>

      {editing ? (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14, display: 'grid', gap: 10 }}>
          <label style={{ display: 'block' }}>
            <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} />
          </label>
          <label style={{ display: 'block' }}>
            <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Problem statement</span>
            <textarea value={need} onChange={(e) => setNeed(e.target.value)} rows={3} style={{ width: '100%', resize: 'vertical' }} />
          </label>
          <label style={{ display: 'block' }}>
            <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Solution / hypothesis</span>
            <textarea value={solution} onChange={(e) => setSolution(e.target.value)} rows={2} style={{ width: '100%', resize: 'vertical' }} />
          </label>
          <div className="row" style={{ gap: 12 }}>
            <label style={{ display: 'block', flex: 1 }}>
              <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Target value (€)</span>
              <input type="number" value={target} onChange={(e) => setTarget(e.target.value)} style={{ width: '100%' }} />
            </label>
            <label style={{ display: 'block', flex: 1 }}>
              <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Go-live date</span>
              <input type="date" value={goLive} onChange={(e) => setGoLive(e.target.value)} style={{ width: '100%' }} />
            </label>
          </div>
          {editErr ? <div className="error">{editErr}</div> : null}
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn ghost sm" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
            <button
              className="btn sm"
              onClick={save}
              disabled={saving || !name.trim() || !target.trim() || Number.isNaN(Number(target)) || !goLive}
            >
              {saving ? <span className="spin" /> : 'Save'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BetHealth({ view }: { view: BetView }) {
  const comps = view.components;
  if (comps.length === 0) return <div className="hint">No components yet.</div>;

  return (
    <div>
      <div style={{ display: 'grid', gap: 8 }}>
        {comps.map((c) => {
          if (!c.visible) {
            return (
              <div key={c.status.refId} className="row" style={{ gap: 10, alignItems: 'center' }}>
                <span className="badge muted" style={{ width: 8, height: 8, borderRadius: '50%', padding: 0 }} />
                <span className="muted" style={{ fontSize: 12.5 }}>🔒 members only</span>
              </div>
            );
          }
          let badgeClass = 'badge muted';
          let label = 'not started';
          if (c.status.blocked) {
            badgeClass = 'badge warn';
            label = 'blocked';
          } else if (c.status.derived === 'completed') {
            badgeClass = 'badge ok';
            label = c.status.lifecycle;
          } else if (c.status.derived === 'in-progress') {
            badgeClass = 'badge warn';
            label = 'in progress';
          }
          return (
            <div key={c.status.refId} className="row" style={{ gap: 10, alignItems: 'center' }}>
              <span className={badgeClass} style={{ width: 8, height: 8, borderRadius: '50%', padding: 0 }} />
              <span style={{ fontSize: 13 }}>{c.artifact?.title ?? '—'}</span>
              <span className="muted" style={{ fontSize: 11.5, marginLeft: 'auto' }}>{label}</span>
            </div>
          );
        })}
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: 12, marginBottom: 0 }}>
        Health derived from governed lifecycle — each component&apos;s authoritative delivery state.
      </p>
    </div>
  );
}
