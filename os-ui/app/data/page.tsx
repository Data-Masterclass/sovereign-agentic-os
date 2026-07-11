/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import PageHeader from '@/components/PageHeader';
import DataTab from '@/components/data/DataTab';
import TalkTo from '@/components/talk/TalkTo';
import { TALK_PRESENTATION } from '@/lib/talk/schema';
import { anchorAttr, ANCHORS } from '@/lib/tutorials/anchors';

// The Data tab is ONE screen, in one scroll: the datasets home on top (the unified,
// Files-style grid — All · My · Shared · Marketplace, with catalog detail folded into
// each dataset), and the shared "Talk to <Tab>" copilot at the bottom (governed NL→SQL,
// with the model's reasoning shown apart from the grounded answer).
// Raw SQL lives in Admin → Query (admin-only); conversational Q&A here is governed NL→SQL.

export default function DataPage() {
  const talk = TALK_PRESENTATION.data;
  return (
    <>
      <PageHeader title="Data" crumb="datasets · ask" tutorial="data" />
      <div className="content">
        {/* Top: the datasets home (tiles → detail → build flow). */}
        <div {...anchorAttr(ANCHORS.data.sandbox)}>
          <DataTab />
        </div>

        {/* Bottom: the shared "Talk to <Tab>" copilot — governed NL→SQL, same OPA/Trino
            path, with the model's reasoning shown apart from the grounded answer. */}
        <div className="query-section" style={{ marginTop: 40 }} {...anchorAttr(ANCHORS.data.query)}>
          <TalkTo tab="data" title={talk.title} blurb={talk.blurb} examples={talk.examples} />
        </div>
      </div>
    </>
  );
}
