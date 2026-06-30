/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@/lib/useUser';
import {
  type MetricGroups,
  type MetricSummary,
  TIER_BADGE,
  TIER_WORD,
} from './shared';

/**
 * The governed metric registry — every measure the user can see, grouped Mine / Domain /
 * Marketplace. Each tile shows the one canonical `member` (the single definition of the
 * number), the owner, a tier badge, and the aggregation. Clicking a tile selects it; the
 * selected tile reveals jump-actions into Explore / Govern.
 */
function MetricCard({
  m,
  selected,
  onSelect,
  onExplore,
  onGovern,
}: {
  m: MetricSummary;
  selected: boolean;
  onSelect: (m: MetricSummary) => void;
  onExplore: (m: MetricSummary) => void;
  onGovern: (m: MetricSummary) => void;
}) {
  return (
    <div
      className={`card tile${selected ? ' sel' : ''}`}
      style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 132, ...(selected ? { borderColor: 'var(--gold)' } : {}) }}
    >
      <button
        type="button"
        onClick={() => onSelect(m)}
        style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}
        title="Select this metric for Explore / Govern"
      >
        <div className="tile-top">
          <span className="tile-name">{m.name}</span>
          <span className={`badge ${TIER_BADGE[m.tier]}`}>{TIER_WORD[m.tier]}</span>
        </div>
        <div className="muted mono" style={{ fontSize: 12 }}>{m.member}</div>
        <div className="tile-meta">
          <span className="muted">{m.owner}</span>
          <span className="dot-sep">·</span>
          <span className="muted">{m.datasetName}</span>
          <span className="dot-sep">·</span>
          <span className="badge muted">{m.type}</span>
        </div>
      </button>
      {selected ? (
        <div className="row" style={{ gap: 8, marginTop: 'auto', paddingTop: 4 }}>
          <button className="btn ghost sm" onClick={() => onExplore(m)}>Explore →</button>
          <button className="btn ghost sm" onClick={() => onGovern(m)}>Govern →</button>
        </div>
      ) : null}
    </div>
  );
}

function Group({
  title,
  metrics,
  selectedId,
  onSelect,
  onExplore,
  onGovern,
}: {
  title: string;
  metrics: MetricSummary[];
  selectedId: string | null;
  onSelect: (m: MetricSummary) => void;
  onExplore: (m: MetricSummary) => void;
  onGovern: (m: MetricSummary) => void;
}) {
  if (metrics.length === 0) return null;
  return (
    <>
      <div className="section-title">{title}<span className="count-pill">{metrics.length}</span></div>
      <div className="tile-grid">
        {metrics.map((m) => (
          <MetricCard
            key={m.id}
            m={m}
            selected={m.id === selectedId}
            onSelect={onSelect}
            onExplore={onExplore}
            onGovern={onGovern}
          />
        ))}
      </div>
    </>
  );
}

export default function MetricsRegistry({
  selectedId,
  onSelect,
  onExplore,
  onGovern,
}: {
  selectedId: string | null;
  onSelect: (m: MetricSummary) => void;
  onExplore: (m: MetricSummary) => void;
  onGovern: (m: MetricSummary) => void;
}) {
  const { user } = useUser();
  const domainLabel = user?.domains[0] ? `${user.domains[0]} domain` : 'your domain';
  const [groups, setGroups] = useState<MetricGroups | null>(null);
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    setErr('');
    try {
      const res = await fetch('/api/metrics', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Failed to load metrics'); return; }
      setGroups(data);
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const empty = groups && groups.mine.length === 0 && groups.domain.length === 0 && groups.marketplace.length === 0;

  return (
    <>
      <p className="lead" style={{ marginTop: 4 }}>
        Every business metric, defined once. Each card carries its single canonical
        definition — the Cube <strong>member</strong> the explorer, dashboards and the agent
        all resolve. Select one to explore it under your own identity, or govern its tier.
      </p>

      {err ? <div className="error" style={{ marginTop: 14 }}>{err}</div> : null}

      {empty ? (
        <div className="stub-page" style={{ marginTop: 20 }}>
          No metrics yet. <strong>Define</strong> one on a governed Gold dataset to see it here.
        </div>
      ) : null}

      {groups ? (
        <>
          <Group title="Personal" metrics={groups.mine} selectedId={selectedId} onSelect={onSelect} onExplore={onExplore} onGovern={onGovern} />
          <Group title={`Shared in ${domainLabel}`} metrics={groups.domain} selectedId={selectedId} onSelect={onSelect} onExplore={onExplore} onGovern={onGovern} />
          <Group title="Marketplace" metrics={groups.marketplace} selectedId={selectedId} onSelect={onSelect} onExplore={onExplore} onGovern={onGovern} />
        </>
      ) : !err ? <div className="stub-page" style={{ marginTop: 20 }}>Loading metrics…</div> : null}
    </>
  );
}
