/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import DatasetTiles from '@tabs/data/ui/DatasetTiles';
import DataBuilder from '@tabs/data/ui/DataBuilder';
import { useTabNavReset } from '@core/kernel/tab-nav';

type TabView =
  | { kind: 'tiles' }
  | { kind: 'detail'; id: string };

/**
 * The Data tab's primary surface. Two levels:
 *   tiles  — the grouped dataset grid (home)
 *   detail — the staged dataset builder (Define · Ingest · Refine · Publish · Use),
 *            on the OS-wide StageShell primitive (DataBuilder). Opening a dataset lands
 *            it at the right stage on its REAL state; creating and working it is one flow.
 *
 * Tiles → single click → the staged builder. Back returns to tiles.
 *
 * The optional `openDatasetId` / `onDatasetOpened` pair lets the Catalog sub-tab
 * open a specific dataset in the builder without lifting shared state into the page
 * component — the parent sets `openDatasetId`, DataTab consumes it once and calls
 * `onDatasetOpened` to clear it (one-shot handoff).
 */
export default function DataTab({
  openDatasetId,
  onDatasetOpened,
}: {
  openDatasetId?: string | null;
  onDatasetOpened?: () => void;
}) {
  const [view, setView] = useState<TabView>({ kind: 'tiles' });

  // Clicking the Data sidebar link while inside a dataset builder returns to the tiles
  // list (same-route client nav wouldn't otherwise re-mount this component).
  useTabNavReset(() => setView({ kind: 'tiles' }));

  // Tell the page whether a dataset is open (so it can hide its own Talk copilot).

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

  if (view.kind === 'detail') {
    return (
      <DataBuilder
        datasetId={view.id}
        onBack={() => setView({ kind: 'tiles' })}
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
