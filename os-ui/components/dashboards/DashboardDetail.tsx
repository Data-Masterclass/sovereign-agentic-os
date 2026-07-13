/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { useUser } from '@/lib/useUser';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import EmbedPanel from './EmbedPanel';
import Reports from './Reports';
import Govern from './Govern';
import { type DashboardSummary, type DashTier, TIER_BADGE, TIER_LABEL } from './shared';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import type { Visibility } from '@/lib/core/lifecycle';
import DomainTag from '@/components/DomainTag';

type Facet = 'view' | 'reports' | 'govern';

/** Dashboard tier → the OS-wide lifecycle visibility (drives the delete gate). */
const lcVis = (tier: DashTier): Visibility =>
  tier === 'domain' ? 'shared' : tier === 'marketplace' ? 'certified' : 'personal';

/**
 * A single dashboard's DETAIL — the one place its viewer / reports / govern fold in, mirroring
 * the Metrics tab. The header is the dashboard's identity (view, chart count, owner, tier); the
 * facets below let you OPEN it under your own row-level security (View — a per-viewer Superset
 * guest token), schedule a delivery of it (Reports), or move its tier (Govern). Reports and
 * Govern are dashboard-scoped, so they live here rather than as top-level tabs.
 */
export default function DashboardDetail({
  dashboard,
  supersetUrl,
  onBack,
  onGoverned,
  onChanged,
}: {
  dashboard: DashboardSummary;
  supersetUrl: string;
  onBack: () => void;
  onGoverned: (tier: DashTier) => void;
  /** Refresh the list after archive/restore/version-restore; delete returns to the list. */
  onChanged: () => void;
}) {
  const [facet, setFacet] = useState<Facet>('view');
  const { user } = useUser();
  const canManage = !!user && canManageArtifact(user, { owner: dashboard.owner, domain: dashboard.domain ?? '' });

  return (
    <ConfirmProvider>
      <button className="btn ghost sm" onClick={onBack} style={{ marginBottom: 14 }}>← All dashboards</button>

      <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>{dashboard.name}</h2>
          {(dashboard.tier === 'domain' || dashboard.tier === 'marketplace') ? <DomainTag domain={dashboard.domain} /> : null}
          <span className={`badge ${TIER_BADGE[dashboard.tier]}`}>{TIER_LABEL[dashboard.tier]}</span>
        </div>
        {canManage ? (
          <LifecycleActions
            id={dashboard.id}
            name={dashboard.name}
            kind="dashboard"
            visibility={lcVis(dashboard.tier)}
            archived={!!dashboard.archived}
            api={`/api/dashboards/${dashboard.id}`}
            handlers={{ onDelete: async () => {
              const res = await fetch(`/api/dashboards/${dashboard.id}`, { method: 'DELETE' });
              if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Delete failed');
              onChanged(); onBack();
            } }}
            onChanged={onChanged}
            compact
          />
        ) : null}
      </div>
      <div className="tile-meta" style={{ marginTop: 6 }}>
        <span className="muted mono" style={{ fontSize: 12 }}>{dashboard.view}</span>
        <span className="dot-sep">·</span>
        <span className="muted">{dashboard.charts} chart{dashboard.charts === 1 ? '' : 's'}</span>
        <span className="dot-sep">·</span>
        <span className="muted">owner {dashboard.owner}</span>
      </div>

      <div className="seg" style={{ marginTop: 16 }}>
        <button className={facet === 'view' ? 'on' : ''} onClick={() => setFacet('view')}>View</button>
        <button className={facet === 'reports' ? 'on' : ''} onClick={() => setFacet('reports')}>Reports</button>
        <button className={facet === 'govern' ? 'on' : ''} onClick={() => setFacet('govern')}>Govern</button>
      </div>

      {facet === 'view' ? <EmbedPanel dashboard={dashboard} supersetUrl={supersetUrl} /> : null}
      {facet === 'reports' ? <Reports dashboard={dashboard} /> : null}
      {facet === 'govern' ? <Govern dashboard={dashboard} onGoverned={onGoverned} /> : null}
    </ConfirmProvider>
  );
}
