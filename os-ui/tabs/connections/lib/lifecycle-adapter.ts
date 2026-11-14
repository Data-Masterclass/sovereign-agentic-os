/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       connections
 * FEATURE:    The connection's PIN-ONLY lifecycle adapter
 * USER STORY: As a builder taking an app or an agent system live I must be able to take the
 *             connections it binds live first.
 * ARCHITECTURE:
 *   - PIN-ONLY: a connection has no artefact dependency of its own, so it declares none and the
 *     guard treats it as a leaf.
 *   - The ref is a content digest of the connection's GOVERNED metadata — endpoint, template,
 *     principal and visibility. Never the credential: a secret must not reach a version ref.
 *   - Imports only `@core/*` and this tab; registered at boot in instrumentation.ts.
 */
import 'server-only';

import type { CurrentUser } from '@core/kernel/auth';
import type { LifecycleAdapter, LifecycleActor } from '@core/kernel/lifecycle-adapters';
import { contentRef } from '@core/infra/content-ref';
import { getConnectionForUser, listConnectionsForUser } from '@tabs/connections/lib/store';

const U = (a: LifecycleActor): CurrentUser =>
  ({ id: a.id, name: a.name ?? a.id, role: a.role, domains: a.domains }) as unknown as CurrentUser;

/** The governed metadata a version ref is computed from — never the secret. */
const govRef = (c: { endpoint: string; template: string; principal: string; visibility: string; type: string }) =>
  contentRef('rev', {
    endpoint: c.endpoint,
    template: c.template,
    principal: c.principal,
    visibility: c.visibility,
    type: c.type,
  });

export const connectionLifecycleAdapter: LifecycleAdapter = {
  kind: 'connection',
  resolve: async (actor, id) => {
    // getConnectionForUser warms the durable cache itself, so there is no separate hydrate here.
    const c = await getConnectionForUser(id, U(actor));
    return {
      kind: 'connection',
      id: c.id,
      name: c.name,
      domain: c.domain,
      head: govRef(c),
      tier: c.visibility,
    };
  },
  canGoLive: async (actor, obj) => {
    const c = await getConnectionForUser(obj.id, U(actor));
    if (c.owner === actor.id) return { ok: true };
    const sameDomain = actor.domains.includes(c.domain);
    if (c.visibility !== 'Personal' && sameDomain && (actor.role === 'domain_admin' || actor.role === 'admin')) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `only ${c.owner} (or a domain admin in ${c.domain}) may change what runs for “${c.name}”`,
    };
  },
  existing: async () => {
    // The async listing hydrates; the sync one would honestly yield nothing on a cold pod, which
    // would make the migration silently pin no connections at all.
    const all = await listConnectionsForUser(
      { id: 'migration', name: 'migration', role: 'admin', domains: [] } as unknown as CurrentUser,
      { includeArchived: true },
    );
    return all.map((c) => ({ id: c.id, head: govRef(c), domain: c.domain }));
  },
};
