/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { MOCK_ARTIFACTS } from '../mock';
import type { HealthItem } from '../types';

/**
 * Artifact-health adapter (lens 5) — unified health across EVERY tab's governed
 * artifacts (data products, metrics, dashboards, apps, connections, agents),
 * tied to the OS lineage graph. READ-ONLY.
 *
 * The product tabs (Data/Metrics/Dashboards/Software/Connections/Agents) live on
 * PARALLEL branches not yet on `main`. So this adapter defines the
 * artifact-health INTERFACE and STUBS the cross-tab sources for kind (mock).
 * Reconcile the live cross-tab readers at consolidation — the interface
 * (HealthItem with lens:'artifacts') is the seam.
 */

export async function collectArtifacts(): Promise<HealthItem[]> {
  // Cross-tab artifact health is stubbed for kind (parallel branches not on main).
  // The mock data products (mart_sales, churn, mart_finance) are demo fixtures —
  // only shown in dev/test, never as fake red artifacts on a real deploy.
  return config.monitoringDemoFixtures ? [...MOCK_ARTIFACTS] : [];
}

