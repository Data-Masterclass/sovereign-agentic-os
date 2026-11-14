/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    The knowledge process's PIN-ONLY lifecycle adapter
 * USER STORY: As a builder taking an agent system live I must be able to take the knowledge it
 *             reads live first, or the go-live guard names a dependency nobody can pin.
 * ARCHITECTURE:
 *   - PIN-ONLY: no `dependencies`. A process's links to other processes are a Knowledge-tab walk;
 *     until it is wired the guard treats a process as a leaf, permissive in the safe direction.
 *   - The ref is the process's REAL content sha (`WorkflowView.sha`) — knowledge is already
 *     content-addressed, so no digest is invented here.
 *   - Imports only `@core/*` and this tab; registered at boot in instrumentation.ts.
 */
import 'server-only';

import type { LifecycleAdapter, LifecycleActor } from '@core/kernel/lifecycle-adapters';
import { getWorkflow, listWorkflows, ensureHydrated, type Principal } from '@tabs/knowledge/lib/store';

const P = (a: LifecycleActor): Principal => ({ id: a.id, domains: a.domains, role: a.role as Principal['role'] });
const PLATFORM: Principal = { id: 'migration', domains: [], role: 'admin' };

export const knowledgeLifecycleAdapter: LifecycleAdapter = {
  kind: 'knowledge',
  resolve: async (actor, id) => {
    await ensureHydrated();
    const w = getWorkflow(id, P(actor));
    return {
      kind: 'knowledge',
      id: w.id,
      name: w.title,
      domain: w.domain,
      head: w.sha || 'unversioned',
      tier: w.visibility,
    };
  },
  canGoLive: async (actor, obj) => {
    await ensureHydrated();
    const w = getWorkflow(obj.id, P(actor));
    if (w.owner === actor.id) return { ok: true };
    const sameDomain = actor.domains.includes(w.domain);
    if (w.visibility !== 'Personal' && sameDomain && (actor.role === 'domain_admin' || actor.role === 'admin')) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `only ${w.owner} (or a domain admin in ${w.domain}) may change what runs for “${w.title}”`,
    };
  },
  existing: async () => {
    await ensureHydrated();
    const g = listWorkflows(PLATFORM);
    const all = [...g.mine, ...g.domain, ...g.marketplace];
    return all.map((w) => ({ id: w.id, head: w.id, domain: w.domain }));
  },
};
