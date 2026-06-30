/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import {
  ARTIFACT_KINDS,
  KIND_LABEL,
  type Pillar,
  type ArtifactKind,
} from '@/lib/strategy/model';
import StrategyDetail from './StrategyDetail';
import NewPillarDrawer from './NewPillarDrawer';
import type { AdoptionBoard } from '@/lib/strategy/adoption-core';

/**
 * Strategy — the agentic-transformation cockpit. Lead with what the user does:
 * the strategic pillars, the business value each realizes (a governed metric,
 * distributed top-down to the Big Bets + components and reconciled back), the
 * targets vs actuals, and the live adoption scoreboard. Builder/Admin define +
 * target; Creators/Users view. Values are RLS-scoped; every edit is audited.
 */

type ListResp = {
  user: { id: string; name: string; domains: string[]; role: string };
  items: Pillar[];
  canCreateTenant: boolean;
  canCreateDomain: boolean;
};

export default function StrategyPage() {
  const [resp, setResp] = useState<ListResp | null>(null);
  const [adoption, setAdoption] = useState<AdoptionBoard | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [pr, ar] = await Promise.all([
        fetch('/api/strategy/pillars', { cache: 'no-store' }),
        fetch('/api/strategy/adoption', { cache: 'no-store' }),
      ]);
      const pj = await pr.json();
      if (!pr.ok) throw new Error(pj.error ?? 'Failed to load pillars');
      const aj = await ar.json();
      setResp(pj as ListResp);
      setAdoption(ar.ok ? (aj as AdoptionBoard) : null);
      setSelected((cur) => cur ?? (pj.items?.[0]?.id ?? null));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const canCreate = Boolean(resp?.canCreateTenant || resp?.canCreateDomain);
  const tenant = adoption?.tenant;
  // Headline: certified data products across the tenant + active people.
  const certifiedData = tenant ? tenant.counts.data.certified : 0;
  const certifiedTotal = tenant
    ? ARTIFACT_KINDS.reduce((a, k) => a + tenant.counts[k].certified, 0)
    : 0;

  return (
    <>
      <PageHeader title="Strategy" crumb="agentic-transformation cockpit — pillars, value & adoption" />
      <div className="content">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <p className="lead" style={{ maxWidth: 640 }}>
            Where this company invests in its agentic transformation: the strategic{' '}
            <strong>pillars</strong>, the <strong>business value</strong> each realizes (a governed
            metric distributed across its Big Bets), and an <strong>adoption scoreboard</strong>{' '}
            against annual + quarterly targets. Pillars answer <em>where &amp; why to invest</em>;
            Big Bets deliver it.
          </p>
          {canCreate ? (
            <button className="btn" onClick={() => setCreating(true)}>
              + Define pillar
            </button>
          ) : null}
        </div>

        {/* Tenant scorecard strip */}
        <div className="statusbar" style={{ marginTop: 8 }}>
          <ScoreCard label="Strategic pillars" value={String(resp?.items.length ?? 0)} sub="tenant + domain" />
          <ScoreCard
            label="Active Builders"
            value={String(tenant?.activeBuilders ?? 0)}
            sub={`${tenant?.activeCreators ?? 0} active Creators`}
          />
          <ScoreCard label="Certified data products" value={String(certifiedData)} sub="live from the registry" />
          <ScoreCard label="Certified artifacts" value={String(certifiedTotal)} sub="all kinds · by domain" />
        </div>

        {error ? <div className="error" style={{ marginTop: 16 }}>{error}</div> : null}

        {loading && !resp ? (
          <div className="stub-page" style={{ marginTop: 20 }}>Loading strategy…</div>
        ) : null}

        {resp ? (
          <div className="strat-grid" style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 18, marginTop: 18, alignItems: 'start' }}>
            {/* Pillar rail */}
            <div style={{ display: 'grid', gap: 10 }}>
              <div className="section-title" style={{ marginTop: 0 }}>Pillars</div>
              {resp.items.length === 0 ? (
                <div className="muted" style={{ fontSize: 12.5 }}>No pillars yet.</div>
              ) : (
                resp.items.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSelected(p.id)}
                    className={`card pillar-pick${selected === p.id ? ' selected' : ''}`}
                    style={{
                      textAlign: 'left',
                      cursor: 'pointer',
                      borderColor: selected === p.id ? 'var(--gold-line)' : undefined,
                      background: selected === p.id ? 'var(--gold-soft)' : undefined,
                    }}
                  >
                    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 13.5 }}>{p.name}</span>
                      <span className={`badge ${p.scope === 'tenant' ? 'ok' : 'muted'}`} style={{ fontSize: 10 }}>
                        {p.scope === 'tenant' ? 'tenant' : p.domain}
                      </span>
                    </div>
                    <div className="muted" style={{ fontSize: 11.5, marginTop: 4, whiteSpace: 'normal' }}>
                      {p.metrics[0]?.title ?? 'No metric linked'} · {p.betIds.length} bet
                      {p.betIds.length === 1 ? '' : 's'}
                    </div>
                  </button>
                ))
              )}
            </div>

            {/* Detail */}
            <div>
              {selected ? (
                <StrategyDetail pillarId={selected} onChanged={reload} />
              ) : (
                <div className="stub-page">Select a pillar.</div>
              )}
            </div>
          </div>
        ) : null}

        {/* Adoption scoreboard */}
        {adoption ? <AdoptionScoreboard board={adoption} /> : null}

        <div className="hint" style={{ marginTop: 22 }}>
          Values are RLS-scoped governed metrics — two viewers see only their entitled numbers, the
          same figure agents and Dashboards resolve. Adoption counts derive live from the registry +
          OpenMetadata (tier); active people from recent authoring activity. Every pillar/target edit
          is audited.
        </div>
      </div>

      {creating && resp ? (
        <NewPillarDrawer
          canCreateTenant={resp.canCreateTenant}
          domains={resp.user.domains}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setSelected(id);
            reload();
          }}
        />
      ) : null}
    </>
  );
}

function ScoreCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <h3>{label}</h3>
      <div className="big">{value}</div>
      <div className="muted">{sub}</div>
    </div>
  );
}

function AdoptionScoreboard({ board }: { board: AdoptionBoard }) {
  const rows = [board.tenant, ...board.domains.filter((d) => d.domain !== 'tenant')];
  return (
    <>
      <div className="section-title">Adoption scoreboard · promoted / certified by domain</div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Domain</th>
              {ARTIFACT_KINDS.map((k) => (
                <th key={k} style={{ textAlign: 'center' }}>{KIND_LABEL[k as ArtifactKind]}</th>
              ))}
              <th style={{ textAlign: 'center' }}>Active</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.domain}>
                <td style={{ fontWeight: 600 }}>
                  {d.domain === 'tenant' ? 'Company (tenant)' : d.domain}
                </td>
                {ARTIFACT_KINDS.map((k) => {
                  const c = d.counts[k as ArtifactKind];
                  return (
                    <td key={k} style={{ textAlign: 'center' }} className="mono">
                      <span style={{ color: 'var(--gold-light)' }}>{c.certified}</span>
                      <span className="muted"> / {c.promoted}</span>
                    </td>
                  );
                })}
                <td style={{ textAlign: 'center' }} className="mono">
                  {d.activeBuilders}<span className="muted">B</span> · {d.activeCreators}<span className="muted">C</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="hint">
        Each cell is <span style={{ color: 'var(--gold-light)' }}>certified</span>{' '}
        <span className="muted">/ promoted</span>. Active = Builders·B / Creators·C from authoring
        activity in the last {board.windowDays} days. Derived live — never hand-kept.
      </div>
    </>
  );
}
