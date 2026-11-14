/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       software
 * FEATURE:    The app's PIN-ONLY lifecycle adapter
 * USER STORY: As a builder I want an app to be able to hold a pin like every other kind, so the
 *             go-live guard can name it as a satisfied dependency and so Run can tell an
 *             experiment from the app the company uses.
 * ARCHITECTURE:
 *   - PIN-ONLY: no `dependencies` yet. An app's bindings (`consumes`) are a Software-tab walk;
 *     until it is wired the guard treats an app as a leaf, permissive in the safe direction.
 *   - The ref is the app's SemVer release tag when it has one — the tool's own noun, exactly as
 *     D31 asks — and a content digest of the governed spec metadata otherwise.
 *   - Mapping preview / staging / prod URLs onto the lifecycle is stream S's environment model;
 *     this adapter only lets an app hold a pin.
 *   - Imports only `@core/*` and this tab; registered at boot in instrumentation.ts.
 */
import 'server-only';

import type { CurrentUser } from '@core/kernel/auth';
import type { LifecycleAdapter, LifecycleActor } from '@core/kernel/lifecycle-adapters';
import { contentRef } from '@core/infra/content-ref';
import { getAppForUser, listAppsForUser, type App } from '@tabs/software/lib/apps';

const U = (a: LifecycleActor): CurrentUser =>
  ({ id: a.id, name: a.name ?? a.id, role: a.role, domains: a.domains }) as unknown as CurrentUser;

const PLATFORM = { id: 'migration', name: 'migration', role: 'admin', domains: [] } as unknown as CurrentUser;

/** The SemVer release tag if the app has one — else a digest of its governed metadata. */
export function appRef(a: App): string {
  const releases = a.deploy?.releases;
  const latest = Array.isArray(releases) && releases.length > 0 ? releases[releases.length - 1] : null;
  const version = latest && typeof latest === 'object' ? (latest as { version?: string }).version : undefined;
  if (version) return version;
  return contentRef('rev', { template: a.template, surface: a.surface, grants: a.grants, epics: a.epics });
}

export const appLifecycleAdapter: LifecycleAdapter = {
  kind: 'app',
  resolve: async (actor, id) => {
    const a = await getAppForUser(id, U(actor));
    return {
      kind: 'app',
      id: a.id,
      name: a.name,
      domain: a.domain,
      head: appRef(a),
      tier: a.visibility,
    };
  },
  canGoLive: async (actor, obj) => {
    const a = await getAppForUser(obj.id, U(actor));
    if (a.owner === actor.id) return { ok: true };
    const sameDomain = actor.domains.includes(a.domain);
    if (a.visibility !== 'Personal' && sameDomain && (actor.role === 'domain_admin' || actor.role === 'admin')) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `only ${a.owner} (or a domain admin in ${a.domain}) may change what runs for “${a.name}”`,
    };
  },
  existing: async () => {
    const all = await listAppsForUser(PLATFORM);
    return all.map((a) => ({ id: a.id, head: appRef(a), domain: a.domain }));
  },
};
