/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import PageHeader from '@/components/PageHeader';
import DataTab from '@/components/experimental/data/DataTab';

// The Data tab is ONE screen: the datasets home (the unified, Files-style grid —
// All · My · Shared · Marketplace, with catalog detail folded into each dataset).
// Raw SQL lives in Admin → Query (admin-only); conversational Q&A lives in the
// global Ask-the-OS assistant.

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
  return (
    <>
      <PageHeader title="Data" crumb="datasets · ask" />
      <div className="content">
        {/* The datasets home (tiles → staged builder). */}
        <div>
          <DataTab
            openDatasetId={opened ? null : focusId}
            onDatasetOpened={() => setOpened(true)}
          />
        </div>
      </div>
    </>
  );
}
