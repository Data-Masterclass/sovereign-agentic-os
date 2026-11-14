/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       metrics
 * FEATURE:    The metric's lifecycle adapter — it CAN hold a pin, and it depends on its dataset
 * USER STORY: As a builder taking a dashboard live I must be able to take its metrics live
 *             first. A guard that names a dependency nobody can pin is a refusal with no way out.
 * ARCHITECTURE:
 *   - A metric IS its dataset (its id is `<datasetId>.<measure>`), so the one dependency it
 *     declares is that dataset — exactly the edge the plan names (metric → dataset).
 *   - The ref is a record content digest until the dbt project's commit sha is resolvable per
 *     metric; `core/infra/content-ref.ts` explains the form.
 *   - Imports only `@core/*` and this tab; registered at boot in instrumentation.ts.
 */
import 'server-only';

import type { LifecycleAdapter, LifecycleActor, DependencyRef } from '@core/kernel/lifecycle-adapters';
import { contentRef } from '@core/infra/content-ref';
import { getMetric, listAllMetricsInternal, ensureHydrated, type Principal } from '@tabs/metrics/lib/store';

const P = (a: LifecycleActor): Principal => ({ id: a.id, domains: a.domains, role: a.role as Principal['role'] });

export const metricLifecycleAdapter: LifecycleAdapter = {
  kind: 'metric',
  resolve: async (actor, id) => {
    await ensureHydrated();
    const m = getMetric(id, P(actor));
    return {
      kind: 'metric',
      id: m.id,
      name: m.measure.name,
      domain: m.dataset.domain,
      head: contentRef('rev', { measure: m.measure, member: m.member }),
      tier: m.tier,
    };
  },
  canGoLive: async (actor, obj) => {
    await ensureHydrated();
    const m = getMetric(obj.id, P(actor));
    if (m.owner === actor.id) return { ok: true };
    const sameDomain = actor.domains.includes(m.dataset.domain);
    if (m.tier !== 'personal' && sameDomain && (actor.role === 'domain_admin' || actor.role === 'admin')) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `only ${m.owner} (or a domain admin in ${m.dataset.domain}) may change what runs for “${m.measure.name}”`,
    };
  },
  dependencies: async (actor, obj): Promise<DependencyRef[]> => {
    await ensureHydrated();
    const m = getMetric(obj.id, P(actor));
    return [{ kind: 'dataset', id: m.dataset.id, name: m.dataset.name }];
  },
  existing: async () => {
    await ensureHydrated();
    // A metric has no store row of its own — it IS a measure on a dataset — so the platform
    // enumeration lives beside the measures (store.listAllMetricsInternal), not here.
    return listAllMetricsInternal().map((m) => ({
      id: m.id,
      head: contentRef('rev', { member: m.member }),
      domain: m.domain,
    }));
  },
};
