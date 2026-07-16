/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { useApi } from '@/lib/useApi';
import { useTabNavReset } from '@/lib/core/tab-nav';
import MetricsRegistry from './MetricsRegistry';
import MetricDetail from './MetricDetail';
import DefineMetric from './DefineMetric';
import type { MetricGroups, MetricSummary } from './shared';

type View =
  | { kind: 'list' }
  | { kind: 'detail'; metric: MetricSummary }
  | { kind: 'define' };

/**
 * The Metrics surface — the unified metric home. Three levels, mirroring the Data tab:
 *   list   — the grouped metric grid (All · My · Shared · Marketplace)
 *   detail — one metric, where explore / govern / alert fold in
 *   define — the "＋ Define metric" create flow
 *
 * The parent (page) resets to the list on a sidebar click. This component owns the ONE
 * metrics fetch, shared by the list and by the detail's alert palette.
 */
export default function MetricsTab() {
  const [view, setView] = useState<View>({ kind: 'list' });
  // ?archived=1 additionally returns soft-archived metrics (their own section), so an
  // archived metric stays openable → its detail exposes Restore + Delete (OS-wide rule).
  const [showArchived, setShowArchived] = useState(false);
  const metrics = useApi<MetricGroups>(`/api/metrics${showArchived ? '?archived=1' : ''}`);

  // Clicking the Metrics sidebar link returns to the list from any detail/define view.
  useTabNavReset(() => setView({ kind: 'list' }));

  if (view.kind === 'define') {
    return (
      <>
        <button className="btn ghost sm" onClick={() => setView({ kind: 'list' })} style={{ marginBottom: 14 }}>← All metrics</button>
        <DefineMetric onDefined={() => metrics.reload()} />
      </>
    );
  }

  if (view.kind === 'detail') {
    return (
      <MetricDetail
        metric={view.metric}
        metrics={metrics.data}
        metricsLoading={metrics.loading}
        onBack={() => setView({ kind: 'list' })}
        onGoverned={() => metrics.reload()}
      />
    );
  }

  return (
    <MetricsRegistry
      groups={metrics.data}
      loading={metrics.loading}
      error={metrics.error}
      onOpen={(m) => setView({ kind: 'detail', metric: m })}
      onDefine={() => setView({ kind: 'define' })}
      onReload={() => metrics.reload()}
      showArchived={showArchived}
      onToggleArchived={() => setShowArchived((v) => !v)}
    />
  );
}
