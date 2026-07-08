/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';
import { useTabNavReset } from '@/lib/tab-nav';
import type { DashboardGroups, MetricGroups, DashboardSummary, DashTier } from './shared';
import Tiles from './Tiles';
import NewDashboard from './NewDashboard';
import DashboardDetail from './DashboardDetail';

type View =
  | { kind: 'list' }
  | { kind: 'detail'; dashboard: DashboardSummary }
  | { kind: 'new' };

/**
 * The Dashboards experience — the OS's ONE-view pattern, mirroring Data + Metrics:
 *   list   — the grouped dashboard grid (All · My · Shared · Marketplace), with a
 *            prominent ＋ New dashboard button.
 *   detail — one dashboard, where its embedded VIEWER (per-viewer guest token + RLS),
 *            Reports (scheduled deliveries) and Govern (tier promotion) fold in as facets.
 *   new    — the dual-mode builder, opened from the list, returning to it on build.
 *
 * This component owns the ONE dashboards fetch (list + detail) and the ONE metrics fetch
 * (the builder's palette). Metrics are DEFINED in the Metrics tab — here we only consume
 * them. Conversational Q&A lives in the global Ask-the-OS assistant, not here.
 */
export default function DashboardsTab({ supersetUrl }: { supersetUrl: string }) {
  const [view, setView] = useState<View>({ kind: 'list' });
  // ?archived=1 additionally returns soft-archived dashboards (their own section), so an
  // archived dashboard stays openable → its detail exposes Restore + Delete (OS-wide rule).
  const [showArchived, setShowArchived] = useState(false);
  const dashboards = useApi<DashboardGroups>(`/api/dashboards${showArchived ? '?archived=1' : ''}`);
  const metrics = useApi<MetricGroups>('/api/metrics');

  // Clicking the Dashboards sidebar link returns to the list from any detail/new view.
  useTabNavReset(() => setView({ kind: 'list' }));

  const onGoverned = (tier: DashTier) => {
    setView((v) => (v.kind === 'detail' ? { kind: 'detail', dashboard: { ...v.dashboard, tier } } : v));
    dashboards.reload();
  };

  return (
    <>
      <PageHeader title="Dashboards" crumb="open · build · report · govern — on governed metrics" tutorial="dashboards" />
      <div className="content">
        {view.kind === 'new' ? (
          <>
            <button className="btn ghost sm" onClick={() => setView({ kind: 'list' })} style={{ marginBottom: 14 }}>← All dashboards</button>
            <NewDashboard
              metrics={metrics.data}
              loading={metrics.loading}
              onBuilt={() => { dashboards.reload(); setView({ kind: 'list' }); }}
            />
          </>
        ) : view.kind === 'detail' ? (
          <DashboardDetail
            dashboard={view.dashboard}
            supersetUrl={supersetUrl}
            onBack={() => setView({ kind: 'list' })}
            onGoverned={onGoverned}
            onChanged={() => dashboards.reload()}
          />
        ) : (
          <>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 280 }}>
                <p className="lead" style={{ marginTop: 4 }}>
                  Compose dashboards over your <strong>governed metrics</strong>. Open one — it embeds
                  with your own row-level security — then schedule reports and promote it, right in its detail.
                </p>
                <p className="hint" style={{ marginTop: 0 }}>
                  Metrics are <strong>defined in the Metrics tab</strong> —{' '}
                  <Link href="/metrics" style={{ color: 'var(--teal)', textDecoration: 'underline' }}>open Metrics →</Link>.
                  Dashboards only consume governed metrics.
                </p>
              </div>
              <button className="btn" onClick={() => setView({ kind: 'new' })} style={{ marginTop: 4 }}>＋ New dashboard</button>
            </div>

            <Tiles
              data={dashboards.data}
              loading={dashboards.loading}
              error={dashboards.error}
              onOpen={(d) => setView({ kind: 'detail', dashboard: d })}
              showArchived={showArchived}
              onToggleArchived={() => setShowArchived((v) => !v)}
            />
          </>
        )}
      </div>
    </>
  );
}
