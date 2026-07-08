/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import PageHeader from '@/components/PageHeader';
import MetricsTab from '@/components/metrics/MetricsTab';
import LiveCube from '@/components/metrics/LiveCube';
import { useTabNavReset } from '@/lib/tab-nav';

/**
 * The Metrics tab — one definition of every number, on TWO surfaces (mirroring the Data tab):
 *
 *   Metrics — the unified metric home: the grouped list (All · My · Shared · Marketplace),
 *             where opening a metric folds explore / govern / alert into its detail, and
 *             "＋ Define metric" creates a new one.
 *   Query   — the power-user surface: the live Cube inspection the metrics resolve against.
 *
 * Conversational metric Q&A lives in the global Ask-the-OS assistant, not here.
 */
type View = 'metrics' | 'query';

export default function MetricsPage() {
  const [view, setView] = useState<View>('metrics');

  // Clicking the Metrics sidebar link returns to the primary Metrics surface. MetricsTab
  // separately resets any open detail/define back to the list.
  useTabNavReset(() => setView('metrics'));

  return (
    <>
      <PageHeader title="Metrics" crumb="metrics · query — one definition of every number" tutorial="metrics" />
      <div className="content">
        <div className="tabstrip">
          <button className={view === 'metrics' ? 'active' : ''} onClick={() => setView('metrics')}>Metrics</button>
          <button className={view === 'query' ? 'active' : ''} onClick={() => setView('query')}>Query</button>
        </div>

        {view === 'metrics' ? <MetricsTab /> : null}

        {view === 'query' ? (
          <>
            <p className="lead" style={{ marginTop: 4 }}>
              The power-user surface — inspect the live semantic layer your metrics resolve against.
              Every measure and dimension below is the governed source of a number, served read-only
              under your own identity.
            </p>
            <LiveCube />
          </>
        ) : null}
      </div>
    </>
  );
}
