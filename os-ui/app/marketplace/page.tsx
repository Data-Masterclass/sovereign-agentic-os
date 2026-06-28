/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import { MARKETPLACE, KINDS } from '@/lib/marketplace';
import { type Artifact, ARTIFACT_TYPES, TYPE_LABELS, type ArtifactType } from '@/lib/artifact-model';

type MarketData = { items: Artifact[]; added: string[] };

export default function MarketplacePage() {
  const [data, setData] = useState<MarketData | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [typeFilter, setTypeFilter] = useState<'All' | ArtifactType>('All');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/artifacts/marketplace', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load');
      else setData({ items: body.items ?? [], added: body.added ?? [] });
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const add = useCallback(
    async (a: Artifact) => {
      setBusyId(a.id);
      setError('');
      try {
        const res = await fetch(`/api/artifacts/${a.id}/add`, { method: 'POST' });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          setError(b.error ?? 'Add failed');
        } else await load();
      } finally {
        setBusyId('');
      }
    },
    [load],
  );

  const shown = useMemo(
    () => (data ? (typeFilter === 'All' ? data.items : data.items.filter((i) => i.type === typeFilter)) : []),
    [data, typeFilter],
  );

  return (
    <>
      <PageHeader title="Marketplace" crumb="certified, cross-domain artifacts — add into your workspace" />
      <div className="content">
        <p className="lead">
          The cross-domain catalog of <strong>Certified</strong> artifacts — datasets, dbt
          transformations, metrics, dashboards, agents, and knowledge — published by any
          domain. Add one to drop a copy into your own workspace, where it appears with a{' '}
          <span className="badge vis-certified">Certified</span> badge. Certifying is admin-only.
        </p>

        <div className="tabstrip">
          <button className={typeFilter === 'All' ? 'active' : ''} onClick={() => setTypeFilter('All')}>All</button>
          {ARTIFACT_TYPES.map((t) => (
            <button key={t} className={typeFilter === t ? 'active' : ''} onClick={() => setTypeFilter(t)}>
              {TYPE_LABELS[t]}
            </button>
          ))}
        </div>

        {error ? <div className="error">{error}</div> : null}

        {!data ? (
          <div className="stub-page">Loading the certified catalog…</div>
        ) : shown.length === 0 ? (
          <div className="stub-page">No certified artifacts{typeFilter !== 'All' ? ` of type ${TYPE_LABELS[typeFilter]}` : ''} yet. An admin certifies a Shared artifact to publish it here.</div>
        ) : (
          <div className="grid">
            {shown.map((a) => {
              const added = data.added.includes(a.id);
              return (
                <div className="card launch-card" key={a.id}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <h3 style={{ margin: 0 }}>{a.name}</h3>
                    <span className="badge vis-certified">Certified</span>
                  </div>
                  <div className="muted" style={{ marginTop: 6, fontSize: 11.5 }}>
                    {TYPE_LABELS[a.type]} · from <strong>{a.domain}</strong>
                  </div>
                  <div className="muted" style={{ marginTop: 8, flex: 1, whiteSpace: 'normal' }}>{a.description}</div>
                  {a.tags.length ? (
                    <div className="sources" style={{ marginTop: 10 }}>
                      {a.tags.map((t) => <span className="chip" key={t}>{t}</span>)}
                    </div>
                  ) : null}
                  <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
                    {added ? (
                      <span className="badge ok">✓ In your workspace</span>
                    ) : (
                      <button className="btn" disabled={busyId === a.id} onClick={() => add(a)}>
                        {busyId === a.id ? <span className="spin" /> : 'Add to workspace'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Platform components catalog (static, infra-level) kept as a secondary view. */}
        <div className="section-title" style={{ marginTop: 32 }}>Platform components</div>
        <p className="hint" style={{ marginTop: 0 }}>
          Infrastructure building blocks wired into this deployment (enable/publish governed in the Admin Console).
        </p>
        {KINDS.map((kind) => {
          const comps = MARKETPLACE.filter((m) => m.kind === kind);
          if (comps.length === 0) return null;
          return (
            <div key={kind}>
              <div className="section-title">{kind}s<span className="count-pill">{comps.length}</span></div>
              <div className="grid">
                {comps.map((m) => (
                  <div className="card launch-card" key={m.id}>
                    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                      <h3 style={{ margin: 0 }}>{m.name}</h3>
                      <span className={`badge ${m.installed ? 'ok' : 'muted'}`}>{m.installed ? 'installed' : 'available'}</span>
                    </div>
                    <div className="muted" style={{ marginTop: 6, fontSize: 11.5 }}>{m.publisher}</div>
                    <div className="muted" style={{ marginTop: 8, flex: 1 }}>{m.summary}</div>
                    <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
                      {m.href ? <Link className="btn ghost" href={m.href}>{m.installed ? 'Open →' : 'Learn more →'}</Link> : <button className="btn ghost" disabled>Learn more</button>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
