/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import DashboardsTab from '@/components/dashboards/DashboardsTab';
import { config } from '@/lib/config';

// Thin server wrapper: reads the browser-reachable Superset console URL from the RUNTIME
// env (force-dynamic — same reasoning as the former stub) and hands it to the client
// Dashboards experience as a prop. Everything interactive lives in the client tree.
export const dynamic = 'force-dynamic';

export default function DashboardsPage() {
  return <DashboardsTab supersetUrl={config.supersetUrl} />;
}
