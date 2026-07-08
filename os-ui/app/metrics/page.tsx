/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import PageHeader from '@/components/PageHeader';
import MetricsTab from '@/components/metrics/MetricsTab';
import LiveCube from '@/components/metrics/LiveCube';

/**
 * The Metrics page — one scroll, no subtabs.
 *
 *   Top   — the governed metric registry (All · My · Shared · Marketplace),
 *           with explore / govern / alert folding into the detail view.
 *   Bottom — the live Cube query surface (the semantic layer every metric
 *            resolves against), power-user read-only inspection.
 *
 * Conversational metric Q&A lives in the global Ask-the-OS assistant, not here.
 */
export default function MetricsPage() {
  return (
    <>
      <PageHeader title="Metrics" crumb="one definition of every number" tutorial="metrics" />
      <div className="content">
        {/* Registry — the metric list, detail, and define flow. */}
        <MetricsTab />

        {/* Query — the live semantic layer, below the tiles. */}
        <div style={{ marginTop: 40 }}>
          <div className="section-title" style={{ marginBottom: 8 }}>Query</div>
          <p className="lead" style={{ marginTop: 0 }}>
            The power-user surface — inspect the live semantic layer your metrics resolve against.
            Every measure and dimension below is the governed source of a number, served read-only
            under your own identity.
          </p>
          <LiveCube />
        </div>
      </div>
    </>
  );
}
