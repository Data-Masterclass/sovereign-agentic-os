/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import {
  type BetView, type ValueBasis, type AllocationMethod, eur, fmtDate, problemLine,
} from '../types';
import { ProgressBar, SignalBadge } from '../ui';
import Roadmap from './Roadmap';
import Components from './Components';
import Planner from './Planner';
import ValuePanel from './ValuePanel';
import Composition from './Composition';

export default function BetDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [basis, setBasis] = useState<ValueBasis | ''>('');
  const [allocation, setAllocation] = useState<AllocationMethod | ''>('');
  const [view, setView] = useState<BetView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAudit, setShowAudit] = useState(false);

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
    <>
      <PageHeader title={view ? view.bet.name : 'Big Bet'} crumb="initiative roadmap over real components" />
      <div className="content">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Link href="/big-bets" style={{ color: 'var(--teal)', fontSize: 12.5 }}>← All big bets</Link>
          <Link href="/monitoring" style={{ color: 'var(--teal)', fontSize: 12.5 }}>live health →</Link>
        </div>

        {error ? <div className="error" style={{ marginTop: 14 }}>{error}</div> : null}
        {loading && !view ? <div className="stub-page">Loading bet…</div> : null}

        {view ? (
          <>
            <HeaderBand view={view} />

            <div className="section-title">Roadmap</div>
            <div className="card"><Roadmap view={view} /></div>

            <div className="section-title">Components</div>
            <Components view={view} onMutate={load} />

            <div className="section-title">Planner</div>
            <div className="card"><Planner betId={view.bet.id} onMutate={load} /></div>

            <div className="section-title">Value</div>
            <div className="card">
              <ValuePanel
                view={view}
                basis={basis || view.value.realized.basis}
                allocation={allocation || view.value.distribution.allocation}
                onBasis={setBasis}
                onAllocation={setAllocation}
              />
            </div>

            <div className="section-title">Composition</div>
            <div className="card"><Composition view={view} /></div>

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
                        <span><strong>{a.action}</strong>{a.detail ? <span className="muted"> · {a.detail}</span> : null}</span>
                        <span className="muted mono" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{a.actor} · {fmtDate(a.at.slice(0, 10))}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            <div className="hint" style={{ marginTop: 20 }}>
              Source: <span className="mono">{view.sourceMode}</span>. The bet shows delivery;{' '}
              <Link href="/monitoring" style={{ color: 'var(--teal)' }}>Monitoring</Link> shows runtime health.
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}

function HeaderBand({ view }: { view: BetView }) {
  const b = view.bet;
  const r = view.roadmap;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 280 }}>
          <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <SignalBadge signal={r.signal} />
            <span className="chip">{b.domain}</span>
            {b.crossDomain ? <span className="chip">cross-domain</span> : null}
            <span className="muted" style={{ fontSize: 11.5 }}>owner {b.owner}</span>
          </div>
          <p className="muted" style={{ marginTop: 10, marginBottom: 0, maxWidth: 640, lineHeight: 1.55 }}>
            {problemLine(b.problem)}
          </p>
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
    </div>
  );
}
