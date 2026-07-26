/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import ScienceTab from '@/components/science/ScienceTab';

/**
 * Science — the thin page wrapper (like Dashboards' page). All the experience lives
 * in <ScienceTab/>: the ONE-view model-as-a-service tab (list · detail · new ·
 * developer console). Phase 1 wraps the live churn/KServe slice as the first model;
 * the guided train/deploy runtime and inline eval/monitor charts are later phases.
 */
export default function SciencePage() {
  return <ScienceTab />;
}
