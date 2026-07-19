/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';
import { useTabNavReset } from '@/lib/core/tab-nav';
import type { DashboardGroups, MetricGroups, DashboardSummary } from './shared';
import Tiles from './Tiles';
import DashboardBuilder from './DashboardBuilder';

type View =
  | { kind: 'list' }
  // ONE guided flow for both creating and viewing: `existing` = null → a new dashboard
  // starting on Define; a summary → an already-built dashboard opening at View.
  | { kind: 'builder'; existing: DashboardSummary | null };

/**
 * The Dashboards experience — the OS's ONE-view pattern, mirroring Data + Metrics but now
 * on the shared STAGED builder (Define · Design · Build · View · Govern):
 *   list    — the grouped dashboard grid (All · My · Domain · Company), with a prominent
 *             ＋ New dashboard button.
 *   builder — the guided flow. ＋ New opens it on Define; opening a tile opens it at View,
 *             where the embed, Reports and Govern controls fold in as later stages. Creating
 *             and viewing are no longer disjoint screens — it is one path.
 *
 * This component owns the ONE dashboards fetch (list) and the ONE metrics fetch (the
 * builder's palette). Metrics are DEFINED in the Metrics tab — here we only consume them.
 */
export default function DashboardsTab() {
  const [view, setView] = useState<View>({ kind: 'list' });
  // ?archived=1 additionally returns soft-archived dashboards (their own section), so an
  // archived dashboard stays openable → its Govern stage exposes Restore + Delete.
  const [showArchived, setShowArchived] = useState(false);
  const dashboards = useApi<DashboardGroups>(`/api/dashboards${showArchived ? '?archived=1' : ''}`);
  const metrics = useApi<MetricGroups>('/api/metrics');

  // Clicking the Dashboards sidebar link returns to the list from the builder.
  useTabNavReset(() => setView({ kind: 'list' }));

  return (
    <>
      <PageHeader title="Dashboards" crumb="define · design · build · view · govern — on governed metrics" tutorial="dashboards" />
      <div className="content">
        {view.kind === 'builder' ? (
          <DashboardBuilder
            existing={view.existing}
            metrics={metrics.data}
            metricsLoading={metrics.loading}
            onBack={() => setView({ kind: 'list' })}
            onChanged={() => dashboards.reload()}
          />
        ) : (
          <>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 280 }}>
                <p className="lead" style={{ marginTop: 4 }}>
                  Compose dashboards over your <strong>governed metrics</strong> in five calm steps —
                  Define · Design · Build · View · Govern. Open one — it embeds with your own row-level
                  security — then schedule reports and promote it, all in the same flow.
                </p>
                <p className="hint" style={{ marginTop: 0 }}>
                  Metrics are <strong>defined in the Metrics tab</strong> —{' '}
                  <Link href="/metrics" style={{ color: 'var(--teal)', textDecoration: 'underline' }}>open Metrics →</Link>.
                  Dashboards only consume governed metrics.
                </p>
              </div>
              <div className="row" style={{ gap: 8, marginTop: 4 }}>
                <button
                  className="btn ghost"
                  style={{ opacity: 1 }}
                  onClick={() => setShowArchived((v) => !v)}
                  title="Archived dashboards are hidden by default"
                >
                  {showArchived ? 'Hide archived' : 'Show archived'}
                </button>
                <button className="btn" onClick={() => setView({ kind: 'builder', existing: null })}>＋ New dashboard</button>
              </div>
            </div>

            <Tiles
              data={dashboards.data}
              loading={dashboards.loading}
              error={dashboards.error}
              onOpen={(d) => setView({ kind: 'builder', existing: d })}
              showArchived={showArchived}
            />
          </>
        )}
      </div>
    </>
  );
}
