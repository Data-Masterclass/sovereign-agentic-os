/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       dashboards
 * FEATURE:    The dashboard's lifecycle adapter — Run renders the PINNED spec
 * USER STORY: As someone who looks at a dashboard every morning I need editing it NOT to change
 *             what everyone else sees until the author says so. Today a save is instantly live
 *             for every viewer, which is why nobody dares touch a dashboard people depend on.
 * ARCHITECTURE:
 *   - A dashboard is not git-backed today (its spec lives in the store, with every prior spec in
 *     `versionLog('dashboard')`), so its lifecycle ref is a CONTENT DIGEST of the spec —
 *     `spec:<12 hex>` of canonical JSON. That makes the pin byte-exact without inventing a file:
 *     the pinned spec is whichever retained version hashes to the pin.
 *   - `dashboardForSurface` is the Run/Studio read seam. Studio always gets the draft (you edit
 *     what you are looking at); Run gets the pinned spec, and if the pinned version is no longer
 *     retained it says so and shows NOTHING, rather than silently serving the draft — a wrong
 *     dashboard that looks right is the failure this whole stream exists to prevent.
 *   - Imports only `@core/*` and this tab, so the kernel still never knows the Dashboards tab;
 *     registration happens at boot in instrumentation.ts.
 *   - When D's dashboard-as-code lands, `specRef` becomes the commit sha and nothing else here
 *     changes — the pin is already an opaque ref to everything above this file.
 */
import 'server-only';
import { createHash } from 'node:crypto';

import type { LifecycleAdapter, LifecycleActor, DependencyRef } from '@core/kernel/lifecycle-adapters';
import { livePin } from '@core/infra/lifecycle-pins';
import type { ViewSurface } from '@core/kernel/object-lifecycle';
import {
  getDashboard,
  listDashboardVersions,
  listDashboards,
  ensureHydrated,
  type Principal,
} from '@tabs/dashboards/lib/store';
import { panelMetrics, type DashboardSpec } from '@tabs/dashboards/lib/model';
import { viewOfMember } from '@tabs/dashboards/lib/panel-views';

const P = (a: LifecycleActor): Principal => ({ id: a.id, domains: a.domains, role: a.role as Principal['role'] });

/**
 * The lifecycle ref of one dashboard spec: a digest of its canonical JSON. Stable across
 * processes and restarts, and different for any change a viewer could see.
 */
export function specRef(spec: DashboardSpec): string {
  const canonical = JSON.stringify(spec, Object.keys(flatten(spec)).sort());
  return `spec:${createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`;
}

/** Every key name in the object graph, so JSON.stringify's replacer order is deterministic. */
function flatten(value: unknown, out: Record<string, true> = {}): Record<string, true> {
  if (Array.isArray(value)) {
    for (const v of value) flatten(v, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out[k] = true;
      flatten(v, out);
    }
  }
  return out;
}

export type SurfaceRead =
  | { surface: 'studio'; spec: DashboardSpec; ref: string; live: string | null }
  | { surface: 'run'; spec: DashboardSpec; ref: string; live: string }
  | { surface: 'run'; spec: null; ref: null; live: string | null; unavailable: string };

/**
 * THE Run/Studio read seam. Studio → the draft. Run → the pinned spec, found among the retained
 * versions by digest; a dashboard with no pin is simply not in Run, and a pin whose version has
 * been purged is reported rather than substituted.
 */
export async function dashboardForSurface(
  id: string,
  actor: LifecycleActor,
  surface: ViewSurface,
): Promise<SurfaceRead> {
  await ensureHydrated(); // a cold pod must not answer not_found for a dashboard that exists
  const user = P(actor);
  const rec = getDashboard(id, user); // throws 403/404 as the caller, never widened
  const draftRef = specRef(rec.spec);
  const pin = await livePin('dashboard', id);

  if (surface === 'studio') {
    return { surface: 'studio', spec: rec.spec, ref: draftRef, live: pin?.ref ?? null };
  }
  if (!pin) {
    return {
      surface: 'run',
      spec: null,
      ref: null,
      live: null,
      unavailable: 'this dashboard is not live — go live with a version to serve it in Run',
    };
  }
  if (pin.ref === draftRef) {
    return { surface: 'run', spec: rec.spec, ref: draftRef, live: pin.ref };
  }
  for (const v of listDashboardVersions(id, user)) {
    const spec = (v.state as { spec?: DashboardSpec } | null)?.spec;
    if (spec && specRef(spec) === pin.ref) {
      return { surface: 'run', spec, ref: pin.ref, live: pin.ref };
    }
  }
  return {
    surface: 'run',
    spec: null,
    ref: null,
    live: pin.ref,
    unavailable: `the live version (${pin.ref}) is no longer retained, so Run cannot serve it — go live again to pin the current draft`,
  };
}

/**
 * A dashboard's dependencies: the metric members its panels resolve, and the single governed
 * view it binds to (which is one dataset). Named in the order the refusal should name them.
 */
function dependenciesOf(spec: DashboardSpec): DependencyRef[] {
  const out: DependencyRef[] = [];
  const seen = new Set<string>();
  for (const panel of spec.charts ?? []) {
    for (const member of panelMetrics(panel)) {
      if (seen.has(member)) continue;
      seen.add(member);
      out.push({ kind: 'metric', id: member, name: member });
    }
  }
  if (spec.view) out.push({ kind: 'dataset', id: spec.view, name: spec.view });
  // A panel may resolve a member on a view other than the dashboard's own binding.
  for (const member of seen) {
    const view = viewOfMember(member);
    if (view && view !== spec.view && !seen.has(view)) {
      seen.add(view);
      out.push({ kind: 'dataset', id: view, name: view });
    }
  }
  return out;
}

export const dashboardLifecycleAdapter: LifecycleAdapter = {
  kind: 'dashboard',
  resolve: async (actor, id) => {
    await ensureHydrated();
    const rec = getDashboard(id, P(actor));
    return {
      kind: 'dashboard',
      id: rec.id,
      name: rec.spec.name,
      domain: rec.domain,
      head: specRef(rec.spec),
      tier: rec.tier,
    };
  },
  canGoLive: async (actor, obj) => {
    await ensureHydrated();
    const rec = getDashboard(obj.id, P(actor));
    if (rec.owner === actor.id) return { ok: true };
    // A domain admin may operate a SHARED dashboard IN THEIR OWN DOMAIN — never another's.
    const sameDomain = actor.domains.includes(rec.domain);
    if (rec.tier !== 'personal' && sameDomain && (actor.role === 'domain_admin' || actor.role === 'admin')) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `only ${rec.owner} (or a domain admin in ${rec.domain}) may change what Run serves for “${rec.spec.name}”`,
    };
  },
  dependencies: async (actor, obj) => {
    await ensureHydrated();
    return dependenciesOf(getDashboard(obj.id, P(actor)).spec);
  },
  consequences: async (actor, obj) => {
    await ensureHydrated();
    const rec = getDashboard(obj.id, P(actor));
    const panels = rec.spec.charts?.length ?? 0;
    return [
      `everyone who opens “${rec.spec.name}” in Run sees this version of its ${panels} panel${panels === 1 ? '' : 's'}`,
      'each panel queries as the person looking at it, so the numbers stay row-level scoped',
    ];
  },
  existing: async () => {
    await ensureHydrated();
    // Review M-1: the internal listing carries no domain, and an empty domain would filter the
    // migrated pin out of every clone's pin file. The scope-grouped listing DOES carry it, so the
    // platform enumeration goes through a platform principal and reads each record's own domain.
    const groups = listDashboards({ id: 'migration', domains: [], role: 'admin' }, { includeArchived: true });
    const out: { id: string; head: string; domain: string }[] = [];
    for (const d of [...groups.mine, ...groups.domain, ...groups.marketplace]) {
      const rec = getDashboard(d.id, { id: 'migration', domains: [], role: 'admin' });
      out.push({ id: rec.id, head: specRef(rec.spec), domain: rec.domain });
    }
    return out;
  },
};
