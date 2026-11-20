/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Metrics tab's part of "delete domain" (metrics: the measure and its lifecycle overlay)
 * USER STORY: As the admin deleting a domain I want every metric of it gone — every owner's, archived
 *             ones too — through the tab's own delete, with nothing reported gone that is not.
 * ARCHITECTURE:
 *   - A {@link DomainDeleteComponent} (core/kernel/domain-delete.ts). Each item is removed by the
 *     store's own delete ACTING AS ITS OWNER (a personal item is owner-only by design; the admin's
 *     delete-domain run is the owner's act, audited as the admin's). A store report that names a
 *     leftover (`ok:false`) fails the step: the run stops and says what is left.
 */
import type { DomainDeleteComponent, PlanItem } from '@core/kernel/domain-delete';
import type { Principal } from '@core/kernel/route-server';
import { ensureHydrated, deleteMetric, listMetricOverlaysFor, purgeMetricOverlayForDomainDelete } from '@tabs/metrics/lib/lifecycle';

/** A domain's datasets with their measures (the Data tab provides it: a tab never imports another). */
export type DomainMeasures = (domainId: string) => Promise<{ id: string; owner: string; measures: string[] }[]>;

export function metricsComponent(deps: { owner: (id: string) => Promise<Principal>; datasets: DomainMeasures }): DomainDeleteComponent {
  const measures = async (domainId: string) =>
    (await deps.datasets(domainId)).flatMap((d) => d.measures.map((m) => ({ id: `${d.id}.${m}`, owner: d.owner })));
  return {
    component: 'os.metrics',
    async plan({ domainId }) {
      await ensureHydrated();
      const ms = await measures(domainId);
      const ids = new Set(ms.map((m) => m.id));
      const remove = ms.map((m): PlanItem => ({ component: 'os.metrics', kind: 'metric', id: m.id, label: m.id, owner: m.owner }));
      const dsIds = new Set((await deps.datasets(domainId)).map((d) => d.id));
      for (const o of listMetricOverlaysFor(dsIds)) if (!ids.has(o.id)) remove.push({ component: 'os.metrics', kind: 'metric-overlay', id: o.id, label: `${o.id} (overlay only)` });
      return { component: 'os.metrics', remove, keep: [] };
    },
    async remove(item, { domainId }) {
      if (item.kind === 'metric-overlay' || !(await measures(domainId)).some((m) => m.id === item.id)) {
        return `overlay ${await purgeMetricOverlayForDomainDelete(item.id)}`;
      }
      const r = deleteMetric(item.id, await deps.owner(item.owner!));
      const bad = r.physical.filter((p) => !p.ok);
      if (bad.length) throw new Error(`measure removed, but ${bad.map((b) => JSON.stringify(b)).join('; ')}`);
      return 'deleteMetric (measure, overlay)';
    },
  };
}
