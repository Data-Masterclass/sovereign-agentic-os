/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import DatasetTiles from './DatasetTiles';
import DatasetStepper from './DatasetStepper';

/**
 * The Data tab's primary surface (data-ui-ux.md "as the user sees it"): tiles of
 * datasets → double-click → the Bronze→Silver→Gold stepper. One client component
 * owns the tiles↔stepper navigation so the rest of the page stays declarative.
 */
export default function DataTab() {
  const [openId, setOpenId] = useState<string | null>(null);
  return openId
    ? <DatasetStepper datasetId={openId} onBack={() => setOpenId(null)} />
    : <DatasetTiles onOpen={setOpenId} />;
}
