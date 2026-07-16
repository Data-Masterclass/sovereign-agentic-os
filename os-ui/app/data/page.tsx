/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
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

/**
 * Reads `?focus=<datasetId>` on mount and passes it to DataTab as a one-shot
 * `openDatasetId` so the Evaluate panel's deep links open the correct dataset.
 * DataTab already handles this prop — it jumps straight to the detail view and
 * calls `onDatasetOpened()` to clear the signal so it never re-fires.
 */
export default function DataPage() {
  return (
    <Suspense>
      <DataPageInner />
    </Suspense>
  );
}

function DataPageInner() {
  const searchParams = useSearchParams();
  const focusId = searchParams.get('focus') ? decodeURIComponent(searchParams.get('focus')!) : null;
  const [opened, setOpened] = useState(false);
  const talk = TALK_PRESENTATION.data;
  return (
    <>
      <PageHeader title="Data" crumb="datasets · ask" tutorial="data" />
      <div className="content">
        {/* Top: the datasets home (tiles → detail → build flow). */}
        <div {...anchorAttr(ANCHORS.data.sandbox)}>
          <DataTab
            openDatasetId={opened ? null : focusId}
            onDatasetOpened={() => setOpened(true)}
          />
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
