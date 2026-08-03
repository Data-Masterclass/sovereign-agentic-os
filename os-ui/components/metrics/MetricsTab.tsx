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
import MetricTypeChooser from './MetricTypeChooser';
import { flatMetrics } from './shared';
import type { MetricGroups, MetricSummary } from './shared';
import type { MetricKind } from './MetricTypeChooser';

type View =
  | { kind: 'list' }
  | { kind: 'chooser'; initialDatasetId?: string }
  | { kind: 'builder'; metric: MetricSummary | null; initialDatasetId?: string; metricKind?: MetricKind };

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
function MetricsTabInner({ onDetailChange }: { onDetailChange?: (open: boolean) => void }) {
  const searchParams = useSearchParams();
  const [view, setView] = useState<View>({ kind: 'list' });

  // Tell the page whether a metric detail (the builder or the type chooser) is open — the
  // builder's View carries its own "Talk to Metrics" at the top, so the page-level copilot
  // hides while a detail is open (mirrors the Data tab; no double Talk).
  useEffect(() => { onDetailChange?.(view.kind !== 'list'); }, [view.kind, onDetailChange]);
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
  // flow with that dataset preselected. Lands on the TYPE CHOOSER (Simple vs Complex),
  // exactly like ＋ New — unless ?kind=simple|complex names a path, then it skips straight
  // into the builder. Independent of the metrics fetch, one-shot.
  const newApplied = useRef(false);
  const newDataset = searchParams.get('new') === '1'
    ? (searchParams.get('dataset') ? decodeURIComponent(searchParams.get('dataset')!) : '')
    : null;
  const kindParam = searchParams.get('kind');
  useEffect(() => {
    if (newDataset === null || newApplied.current) return;
    newApplied.current = true;
    const preset = newDataset || undefined;
    if (kindParam === 'simple' || kindParam === 'complex') {
      setView({ kind: 'builder', metric: null, initialDatasetId: preset, metricKind: kindParam });
    } else {
      setView({ kind: 'chooser', initialDatasetId: preset });
    }
  }, [newDataset, kindParam]);

  // Clicking the Metrics sidebar link returns to the list from any builder view.
  useTabNavReset(() => setView({ kind: 'list' }));

  if (view.kind === 'chooser') {
    return (
      <MetricTypeChooser
        initialDatasetId={view.initialDatasetId}
        onBack={() => setView({ kind: 'list' })}
        onPick={(metricKind) => setView({ kind: 'builder', metric: null, initialDatasetId: view.initialDatasetId, metricKind })}
      />
    );
  }

  if (view.kind === 'builder') {
    return (
      <MetricBuilder
        existing={view.metric}
        initialDatasetId={view.initialDatasetId}
        metricKind={view.metricKind}
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
      onDefine={() => setView({ kind: 'chooser' })}
      onReload={() => metrics.reload()}
      showArchived={showArchived}
      onToggleArchived={() => setShowArchived((v) => !v)}
    />
  );
}

export default function MetricsTab({ onDetailChange }: { onDetailChange?: (open: boolean) => void }) {
  return (
    <Suspense>
      <MetricsTabInner onDetailChange={onDetailChange} />
    </Suspense>
  );
}
