/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       data
 * FEATURE:    The dataset's PIN-ONLY lifecycle adapter
 * USER STORY: As a builder taking a dashboard live I must be able to take the metric and the
 *             dataset under it live first. Without an adapter per kind the go-live guard would
 *             name a dependency nobody could ever pin — a refusal with no way out.
 * ARCHITECTURE:
 *   - PIN-ONLY: `resolve` + `canGoLive` + `existing`, and deliberately NO `dependencies`. A
 *     dataset's own upstreams are a lineage walk the Data tab owns; until that is wired, the
 *     guard treats a dataset as a leaf, which is permissive in the safe direction.
 *   - The ref is a record content digest (`rev:<12 hex>`) until the dbt project's commit sha is
 *     resolvable per object — `core/infra/content-ref.ts` says why that is the honest form.
 *   - Imports only `@core/*` and this tab; registered at boot in instrumentation.ts.
 */
import 'server-only';

import type { LifecycleAdapter, LifecycleActor } from '@core/kernel/lifecycle-adapters';
import { contentRef } from '@core/infra/content-ref';
import { getDataset, ensureHydrated, listAllDatasets, type Principal } from '@tabs/data/lib/store';

const P = (a: LifecycleActor): Principal => ({ id: a.id, domains: a.domains, role: a.role as Principal['role'] });

export const datasetLifecycleAdapter: LifecycleAdapter = {
  kind: 'dataset',
  resolve: async (actor, id) => {
    await ensureHydrated();
    const d = getDataset(id, P(actor));
    return {
      kind: 'dataset',
      id: d.id,
      name: d.name,
      domain: d.domain,
      head: contentRef('rev', { versions: d.versions, name: d.name, sync: d.sync }),
      tier: d.tier,
    };
  },
  canGoLive: async (actor, obj) => {
    await ensureHydrated();
    const d = getDataset(obj.id, P(actor));
    if (d.owner === actor.id) return { ok: true };
    const sameDomain = actor.domains.includes(d.domain);
    if (d.tier !== 'dataset' && sameDomain && (actor.role === 'domain_admin' || actor.role === 'admin')) {
      return { ok: true };
    }
    return { ok: false, reason: `only ${d.owner} (or a domain admin in ${d.domain}) may change what runs for “${d.name}”` };
  },
  existing: async () => {
    await ensureHydrated();
    return listAllDatasets().map((d) => ({
      id: d.id,
      head: contentRef('rev', { versions: d.versions, name: d.name, sync: d.sync }),
      domain: d.domain,
    }));
  },
};
