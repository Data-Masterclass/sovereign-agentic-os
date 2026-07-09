/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { readFetch } from '../util';
import { MOCK_ARTIFACTS } from '../mock';
import type { HealthItem } from '../types';

/**
 * Artifact-health adapter (lens 5) — unified health across EVERY tab's governed
 * artifacts (data products, metrics, dashboards, apps, connections, agents) plus
 * Science/ML (MLflow registry + KServe serving health, drift, prediction latency),
 * tied to OpenMetadata lineage. READ-ONLY.
 *
 * The product tabs (Data/Metrics/Dashboards/Software/Connections/Agents + MLflow/
 * KServe) live on PARALLEL branches not yet on `main`. So this adapter defines the
 * artifact-health INTERFACE and STUBS the cross-tab sources for kind (mock),
 * probing MLflow/KServe live where present. Reconcile the live cross-tab readers
 * at consolidation — the interface (HealthItem with lens:'artifacts') is the seam.
 */

export async function collectArtifacts(): Promise<HealthItem[]> {
  // Live probe: KServe serving health for any deployed model (best-effort).
  const ml = await kserveServing();
  // Cross-tab artifact health is stubbed for kind (parallel branches not on main).
  const crossTab = [...MOCK_ARTIFACTS];

  if (ml.length === 0) return crossTab;
  // Merge: live ML serving replaces the mock churn-model row when present.
  const byTitle = new Map(crossTab.map((a) => [a.title, a]));
  for (const m of ml) byTitle.set(m.title, m);
  return [...byTitle.values()];
}

/** Best-effort read of KServe InferenceService readiness. Empty when off. */
async function kserveServing(): Promise<HealthItem[]> {
  const res = await readFetch(`${config.kserveUrl}/v1/models`, { headers: { accept: 'application/json' } });
  if (!res || !res.ok) return [];
  try {
    const data = JSON.parse(await res.text());
    const models = Array.isArray(data?.models) ? data.models : [];
    return models.map((m: Record<string, unknown>): HealthItem => ({
      id: `art-ml-${String(m.name ?? 'model')}`,
      lens: 'artifacts',
      title: `${String(m.name ?? 'model')} (KServe serving)`,
      health: m.ready === false ? 'red' : 'green',
      detail: `Serving ${m.ready === false ? 'DOWN' : 'up'}. Drift + p95 latency via MLflow metrics.`,
      owner: 'sales',
      domain: 'sales',
      links: { artifactId: `art-ml-${String(m.name ?? 'model')}` },
      source: 'live',
    }));
  } catch {
    return [];
  }
}
