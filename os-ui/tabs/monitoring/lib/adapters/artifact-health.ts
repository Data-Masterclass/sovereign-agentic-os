/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Artifact-health adapter (lens 5) — health of governed artifacts across tabs
 * USER STORY: As a domain owner I want one health list for my data products, metrics,
 *             dashboards, apps, connections and agents so that I see which artifact is stale.
 * ARCHITECTURE:
 *   - Server-only, read-only; called by `aggregate.ts` `collectAll`.
 *   - No live cross-tab reader is wired: it returns `MOCK_ARTIFACTS` when
 *     `config.monitoringDemoFixtures` is on (dev/test) and `[]` otherwise. The `HealthItem`
 *     shape with `lens: 'artifacts'` is the seam for a future live reader.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { MOCK_ARTIFACTS } from '@tabs/monitoring/lib/mock';
import type { HealthItem } from '@tabs/monitoring/lib/types';

export async function collectArtifacts(): Promise<HealthItem[]> {
  // Cross-tab artifact health is stubbed for kind (parallel branches not on main).
  // The mock data products (mart_sales, churn, mart_finance) are demo fixtures —
  // only shown in dev/test, never as fake red artifacts on a real deploy.
  return config.monitoringDemoFixtures ? [...MOCK_ARTIFACTS] : [];
}

