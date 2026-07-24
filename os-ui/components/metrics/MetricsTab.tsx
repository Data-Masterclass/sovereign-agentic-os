/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useApi } from '@/lib/useApi';
import { useTabNavReset } from '@/lib/core/tab-nav';
import MetricsRegistry from './MetricsRegistry';
import MetricBuilder from './MetricBuilder';
import { flatMetrics } from './shared';
import type { MetricGroups, MetricSummary } from './shared';

type View =
  | { kind: 'list' }
  | { kind: 'builder'; metric: MetricSummary | null; initialDatasetId?: string };

/**
 * The Metrics surface — the unified metric home. Two levels:
 *   list    — the grouped metric grid (All · My · Domain · Company)
 *   builder — the staged guided flow (Define · Refine · Preview · Publish · Monitor)
 *             used for both creating a new metric (metric=null) and viewing/editing an
 *             existing one (existing metric opens at Monitor).
 *
 * MetricBuilder unifies define → publish into one continuous staged flow, not two
 * disconnected screens.
 */
function MetricsTabInner() {
  const searchParams = useSearchParams();
  const [view, setView] = useState<View>({ kind: 'list' });
  // ?archived=1 additionally returns soft-archived metrics (their own section), so an
  // archived metric stays openable → its detail exposes Restore + Delete (OS-wide rule).
  const [showArchived, setShowArchived] = useState(false);
  const metrics = useApi<MetricGroups>(`/api/metrics${showArchived ? '?archived=1' : ''}`);

  // ?focus=<metricId> deep-link: once metrics load, open that metric in the builder.
  // Uses flatMetrics to search across all three scope groups (mine/domain/marketplace).
  // A ref prevents re-firing after the initial selection.
  const focusApplied = useRef(false);
  const focusId = searchParams.get('focus') ? decodeURIComponent(searchParams.get('focus')!) : null;
  useEffect(() => {
    if (!focusId || focusApplied.current || !metrics.data) return;
    const target = flatMetrics(metrics.data).find((m) => m.id === focusId);
    if (!target) return; // unknown id — no-op
    focusApplied.current = true;
    setView({ kind: 'builder', metric: target });
  }, [focusId, metrics.data]);

  // ?new=1&dataset=<id> deep-link (from the Data tab's Publish stage): open the create
  // flow with that dataset preselected. Independent of the metrics fetch, one-shot.
  const newApplied = useRef(false);
  const newDataset = searchParams.get('new') === '1'
    ? (searchParams.get('dataset') ? decodeURIComponent(searchParams.get('dataset')!) : '')
    : null;
  useEffect(() => {
    if (newDataset === null || newApplied.current) return;
    newApplied.current = true;
    setView({ kind: 'builder', metric: null, initialDatasetId: newDataset || undefined });
  }, [newDataset]);

  // Clicking the Metrics sidebar link returns to the list from any builder view.
  useTabNavReset(() => setView({ kind: 'list' }));

  if (view.kind === 'builder') {
    return (
      <MetricBuilder
        existing={view.metric}
        initialDatasetId={view.initialDatasetId}
        metrics={metrics.data}
        metricsLoading={metrics.loading}
        onBack={() => setView({ kind: 'list' })}
        onChanged={() => metrics.reload()}
      />
    );
  }

  return (
    <MetricsRegistry
      groups={metrics.data}
      loading={metrics.loading}
      error={metrics.error}
      onOpen={(m) => setView({ kind: 'builder', metric: m })}
      onDefine={() => setView({ kind: 'builder', metric: null })}
      onReload={() => metrics.reload()}
      showArchived={showArchived}
      onToggleArchived={() => setShowArchived((v) => !v)}
    />
  );
}

export default function MetricsTab() {
  return (
    <Suspense>
      <MetricsTabInner />
    </Suspense>
  );
}
