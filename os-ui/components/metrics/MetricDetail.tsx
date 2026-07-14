/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import ExploreMetric from './ExploreMetric';
import Alerts from './Alerts';
import { type MetricGroups, type MetricSummary, TIER_BADGE, TIER_WORD } from './shared';
import { useUser } from '@/lib/useUser';
import { roleAtLeast } from '@/lib/core/session';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import DomainTag from '@/components/DomainTag';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import PromoteButton, { type PromoteTier } from '@/components/lifecycle/PromoteButton';
import type { Visibility } from '@/lib/core/lifecycle';

/** Metric tier → the OS-wide lifecycle visibility (drives the delete gate). */
const lcVis = (tier: MetricSummary['tier']): Visibility =>
  tier === 'domain' ? 'shared' : tier === 'marketplace' ? 'certified' : 'personal';

/** Metric tier → the shared ladder tier the PromoteButton speaks. */
const ladderTier = (tier: MetricSummary['tier']): PromoteTier =>
  tier === 'domain' ? 'Shared' : tier === 'marketplace' ? 'Marketplace' : 'Personal';

/**
 * A single metric's DETAIL — ONE calm scrolling view (no subtabs). Top to bottom:
 *   1. Explore — preview the metric's governed values (the main content);
 *   2. Alerts — set a threshold on this metric's member, folded inline here;
 *   3. Lifecycle — the shared Promote/Certify control + Archive/Delete/Version.
 * The header stays the metric's canonical definition (member, host dataset, owner, tier).
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
  const { user } = useUser();
  // Owner, an in-domain domain_admin, or an admin manages the metric (the server
  // re-checks either way — this only decides whether to surface the controls).
  const canManage = !!user && canManageArtifact(user, { owner: metric.owner, domain: metric.domain ?? '' });
  // Metrics promote at the Builder rung (the data lifecycle gate) — surface it as
  // "can approve" so the button says Promote (not Propose) for a Builder+.
  const canApprove = !!user && roleAtLeast(user.role, 'builder');
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

      {/* 1 — Explore (main content) */}
      <div style={{ marginTop: 18 }}>
        <ExploreMetric metric={metric} />
      </div>

      {/* 2 — Alerts, folded inline */}
      <div className="section-title">Alerts</div>
      <p className="lead" style={{ marginTop: 0 }}>
        Notify me when <strong>{metric.member}</strong> crosses a threshold — and optionally
        trigger a governed agent to respond. The alert reads the same governed number the
        explorer and dashboards resolve.
      </p>
      <Alerts metrics={metrics} loading={metricsLoading} presetMember={metric.member} />

      {/* 3 — Lifecycle: promote/certify + archive/delete/version */}
      {canManage ? (
        <>
          <div className="section-title">Lifecycle</div>
          <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <PromoteButton
              id={metric.id}
              kind="metric"
              tier={ladderTier(metric.tier)}
              promoteUrl={`/api/metrics/${metric.id}/promote`}
              canApprove={canApprove}
              onDone={onGoverned}
            />
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
        </>
      ) : null}
    </ConfirmProvider>
  );
}
