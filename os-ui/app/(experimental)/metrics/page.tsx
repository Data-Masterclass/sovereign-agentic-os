/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import PageHeader from '@core/ui/PageHeader';
import MetricsTab from '@tabs/metrics/ui/MetricsTab';

/**
 * The Metrics page — one scroll, no subtabs.
 *
 *   The governed metric registry (All · My · Shared · Marketplace), with
 *   explore / govern / alert folding into the detail view. Every tile is a
 *   metric the caller actually owns or can see — nothing is hard-wired to a
 *   demo cube.
 *
 * Conversational metric Q&A lives in the global Ask-the-OS assistant, not here.
 */
export default function MetricsPage() {
  return (
    <>
      <PageHeader title="Metrics" crumb="one definition of every number" />
      <div className="content">
        {/* Registry — the metric list, detail, and define flow. */}
        <MetricsTab />
      </div>
    </>
  );
}
