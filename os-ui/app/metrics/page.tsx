/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import PageHeader from '@/components/PageHeader';
import MetricsTab from '@/components/metrics/MetricsTab';
import TalkTo from '@/components/talk/TalkTo';
import { TALK_PRESENTATION } from '@/lib/talk/schema';

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
  const talk = TALK_PRESENTATION.metrics;
  return (
    <>
      <PageHeader title="Metrics" crumb="one definition of every number" tutorial="metrics" />
      <div className="content">
        {/* Registry — the metric list, detail, and define flow. */}
        <MetricsTab />

        {/* Talk to Metrics — metadata-grounded Q&A over metric definitions. */}
        <div style={{ marginTop: 40 }}>
          <TalkTo tab="metrics" title={talk.title} blurb={talk.blurb} examples={talk.examples} />
        </div>
      </div>
    </>
  );
}
