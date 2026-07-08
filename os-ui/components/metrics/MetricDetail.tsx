/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import ExploreMetric from './ExploreMetric';
import GovernMetric from './GovernMetric';
import Alerts from './Alerts';
import { type MetricGroups, type MetricSummary, TIER_BADGE, TIER_WORD } from './shared';
import { useUser } from '@/lib/useUser';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import DomainTag from '@/components/DomainTag';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import type { Visibility } from '@/lib/lifecycle';

type Facet = 'explore' | 'govern' | 'alert';

/** Metric tier → the OS-wide lifecycle visibility (drives the delete gate). */
const lcVis = (tier: MetricSummary['tier']): Visibility =>
  tier === 'domain' ? 'shared' : tier === 'marketplace' ? 'certified' : 'personal';

/**
 * A single metric's DETAIL — the one place define/govern/explore/alert fold into. The
 * header is the metric's canonical definition (member, host dataset, owner, tier); the
 * facets below let you PREVIEW its values (Explore), move its tier (Govern), or set an
 * ALERT on it. `metrics` is the same grouped payload the list loads, passed through so the
 * alert facet's palette is warm; the alert here is locked to THIS metric's member.
 */
export default function MetricDetail({
  metric,
  metrics,
  metricsLoading,
  onBack,
  onGoverned,
}: {
  metric: MetricSummary;
  metrics: MetricGroups | null;
  metricsLoading: boolean;
  onBack: () => void;
  onGoverned: () => void;
}) {
  const [facet, setFacet] = useState<Facet>('explore');
  const { user } = useUser();
  // Owner or an in-domain Admin manages the metric (the server re-checks either way —
  // this only decides whether to surface the controls).
  const canManage = !!user && (metric.owner === user.id || user.role === 'admin');
  // After archive/delete, refresh the registry and drop back to the list (the metric may
  // be gone or hidden); the govern reload alone would leave a stale open detail.
  const onLifecycle = () => { onGoverned(); onBack(); };

  return (
    <ConfirmProvider>
      <button className="btn ghost sm" onClick={onBack} style={{ marginBottom: 14 }}>← All metrics</button>

      <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{metric.name}</h2>
        <span className={`badge ${TIER_BADGE[metric.tier]}`}>{TIER_WORD[metric.tier]}</span>
        {(metric.tier === 'domain' || metric.tier === 'marketplace') ? (
          <DomainTag domain={metric.domain} />
        ) : null}
        {canManage ? (
          <div style={{ marginLeft: 'auto' }}>
            <LifecycleActions
              id={metric.id}
              name={metric.name}
              kind="metric"
              visibility={lcVis(metric.tier)}
              archived={!!metric.archived}
              api={`/api/metrics/${metric.id}`}
              onChanged={onLifecycle}
              compact
            />
          </div>
        ) : null}
      </div>
      <div className="tile-meta" style={{ marginTop: 6 }}>
        <span className="muted mono" style={{ fontSize: 12 }}>{metric.member}</span>
        <span className="dot-sep">·</span>
        <span className="muted">{metric.owner}</span>
        <span className="dot-sep">·</span>
        <span className="muted">{metric.datasetName}</span>
        <span className="dot-sep">·</span>
        <span className="badge muted">{metric.type}</span>
      </div>

      <div className="seg" style={{ marginTop: 16 }}>
        <button className={facet === 'explore' ? 'on' : ''} onClick={() => setFacet('explore')}>Explore</button>
        <button className={facet === 'govern' ? 'on' : ''} onClick={() => setFacet('govern')}>Govern</button>
        <button className={facet === 'alert' ? 'on' : ''} onClick={() => setFacet('alert')}>Alert</button>
      </div>

      {facet === 'explore' ? <ExploreMetric metric={metric} /> : null}
      {facet === 'govern' ? <GovernMetric metric={metric} onGoverned={onGoverned} /> : null}
      {facet === 'alert' ? (
        <>
          <p className="lead" style={{ marginTop: 14 }}>
            Notify me when <strong>{metric.member}</strong> crosses a threshold — and optionally
            trigger a governed agent to respond. The alert reads the same governed number the
            explorer and dashboards resolve.
          </p>
          <Alerts metrics={metrics} loading={metricsLoading} presetMember={metric.member} />
        </>
      ) : null}
    </ConfirmProvider>
  );
}
