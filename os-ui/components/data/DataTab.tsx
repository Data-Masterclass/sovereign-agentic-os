/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import DatasetTiles from './DatasetTiles';
import DatasetDetail from './DatasetDetail';
import DatasetStepper from './DatasetStepper';
import { useTabNavReset } from '@/lib/core/tab-nav';

type TabView =
  | { kind: 'tiles' }
  | { kind: 'detail'; id: string }
  | { kind: 'stepper'; id: string };

/**
 * The Data tab's primary surface. Three levels:
 *   tiles  — the grouped dataset grid (home)
 *   detail — the dataset detail panel: status chips, docs, data checks (new)
 *   stepper — the Bronze→Silver→Gold build flow (existing)
 *
 * Tiles → single click → detail → "Build / refine →" → stepper.
 * Back from stepper returns to detail (not tiles) so context is preserved.
 *
 * The optional `openDatasetId` / `onDatasetOpened` pair lets the Catalog sub-tab
 * open a specific dataset in the detail view without lifting shared state into
 * the page component — the parent sets `openDatasetId`, DataTab consumes it once
 * and calls `onDatasetOpened` to clear it (one-shot handoff).
 */
export default function DataTab({
  openDatasetId,
  onDatasetOpened,
}: {
  openDatasetId?: string | null;
  onDatasetOpened?: () => void;
}) {
  const [view, setView] = useState<TabView>({ kind: 'tiles' });

  // Clicking the Data sidebar link while inside a dataset detail/stepper returns to
  // the tiles list (same-route client nav wouldn't otherwise re-mount this component).
  useTabNavReset(() => setView({ kind: 'tiles' }));

  // One-shot handoff: when the catalog (or any external caller) sets openDatasetId,
  // jump to the detail view and immediately clear the signal so it doesn't re-fire.
  useEffect(() => {
    if (openDatasetId) {
      setView({ kind: 'detail', id: openDatasetId });
      onDatasetOpened?.();
    }
    // Intentionally only re-runs when openDatasetId changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDatasetId]);

  if (view.kind === 'stepper') {
    return (
      <DatasetStepper
        datasetId={view.id}
        // Back from stepper → detail (not tiles), so the user doesn't lose their place.
        onBack={() => setView({ kind: 'detail', id: view.id })}
      />
    );
  }

  if (view.kind === 'detail') {
    return (
      <DatasetDetail
        datasetId={view.id}
        onBack={() => setView({ kind: 'tiles' })}
        onOpenStepper={(id) => setView({ kind: 'stepper', id })}
      />
    );
  }

  return (
    <DatasetTiles
      // Single click → detail view (the readable/documentable surface).
      onOpen={(id) => setView({ kind: 'detail', id })}
    />
  );
}
