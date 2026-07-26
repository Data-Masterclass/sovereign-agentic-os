/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import DashboardsTab from '@/components/dashboards/DashboardsTab';

// Thin server wrapper; force-dynamic so the page is always rendered at request time
// (the Dashboards tab's API routes are all dynamic). Everything interactive lives in
// the client tree; the embed uses the same-origin /tools/superset proxy directly.
export const dynamic = 'force-dynamic';

export default function DashboardsPage() {
  return <DashboardsTab />;
}
