/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useUser } from '@/lib/useUser';
import { roleAtLeast } from '@/lib/core/session';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import EmbedPanel from './EmbedPanel';
import Reports from './Reports';
import { type DashboardSummary, type DashTier, TIER_BADGE, TIER_LABEL } from './shared';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import PromoteButton, { type PromoteTier } from '@/components/lifecycle/PromoteButton';
import type { Visibility } from '@/lib/core/lifecycle';
import DomainTag from '@/components/DomainTag';

/** Dashboard tier → the OS-wide lifecycle visibility (drives the delete gate). */
const lcVis = (tier: DashTier): Visibility =>
  tier === 'domain' ? 'shared' : tier === 'marketplace' ? 'certified' : 'personal';

/** Dashboard tier → the shared ladder tier the PromoteButton speaks. */
const ladderTier = (tier: DashTier): PromoteTier =>
  tier === 'domain' ? 'Shared' : tier === 'marketplace' ? 'Marketplace' : 'Personal';

/**
 * A single dashboard's DETAIL — ONE calm scrolling view (no subtabs). Top to bottom:
 *   1. View — the embedded Superset dashboard under the viewer's own RLS guest token;
 *   2. Reports — schedule a delivery of it, folded inline here;
 *   3. Lifecycle — the shared Promote/Certify control + Archive/Delete/Version.
 * The header stays the dashboard's identity (view, chart count, owner, tier).
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
  const { user } = useUser();
  const canManage = !!user && canManageArtifact(user, { owner: dashboard.owner, domain: dashboard.domain ?? '' });
  // Dashboards promote at the Builder rung — surface it as "can approve" so the button
  // says Promote (not Propose) for a Builder+.
  const canApprove = !!user && roleAtLeast(user.role, 'builder');

  return (
    <ConfirmProvider>
      <button className="btn ghost sm" onClick={onBack} style={{ marginBottom: 14 }}>← All dashboards</button>

      <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{dashboard.name}</h2>
        {(dashboard.tier === 'domain' || dashboard.tier === 'marketplace') ? <DomainTag domain={dashboard.domain} /> : null}
        <span className={`badge ${TIER_BADGE[dashboard.tier]}`}>{TIER_LABEL[dashboard.tier]}</span>
      </div>
      <div className="tile-meta" style={{ marginTop: 6 }}>
        <span className="muted mono" style={{ fontSize: 12 }}>{dashboard.view}</span>
        <span className="dot-sep">·</span>
        <span className="muted">{dashboard.charts} chart{dashboard.charts === 1 ? '' : 's'}</span>
        <span className="dot-sep">·</span>
        <span className="muted">owner {dashboard.owner}</span>
      </div>

      {/* 1 — View (the embedded Superset dashboard) */}
      <div style={{ marginTop: 18 }}>
        <EmbedPanel dashboard={dashboard} supersetUrl={supersetUrl} />
      </div>

      {/* 2 — Reports, folded inline */}
      <div className="section-title">Reports</div>
      <Reports dashboard={dashboard} />

      {/* 3 — Lifecycle: promote/certify + archive/delete/version */}
      {canManage ? (
        <>
          <div className="section-title">Lifecycle</div>
          <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <PromoteButton
              id={dashboard.id}
              kind="dashboard"
              tier={ladderTier(dashboard.tier)}
              promoteUrl={`/api/dashboards/${dashboard.id}/promote`}
              canApprove={canApprove}
              onDone={() => onGoverned(dashboard.tier === 'personal' ? 'domain' : 'marketplace')}
            />
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
          </div>
        </>
      ) : null}
    </ConfirmProvider>
  );
}
