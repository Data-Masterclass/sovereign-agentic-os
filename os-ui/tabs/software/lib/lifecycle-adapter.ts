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
 *   - App Builder (F): with the flag ON, `canGoLive` asks the global go-live rule table (Platform → Go-live rules,
 *     core/policy/go-live-rules.ts) for the app's scope (Personal → My, Shared → Domain, Certified → Company).
 *     Reviewer `none`: anyone who may edit the app changes what runs (the owner; an in-domain domain admin or an
 *     admin for a Shared/Certified app). Any other reviewer: this direct go-live counts as the REVIEW of the
 *     owner's work, so the actor must satisfy `canReview` with the app's owner as the requester — the owner never
 *     goes live alone where a review is required (no self-approval, not configurable), and a reviewer of a lower
 *     role, or of another domain below admin, is refused with the rule's own reason. The rules decide WHO; every
 *     gate the go-live service runs (dependencies, versions) still applies. With the flag OFF the check is exactly
 *     the one before App Builder.
 *   - Imports only `@core/*` and this tab; registered at boot in instrumentation.ts.
 */
import 'server-only';

import type { CurrentUser } from '@core/kernel/auth';
import type { LifecycleAdapter, LifecycleActor } from '@core/kernel/lifecycle-adapters';
import { contentRef } from '@core/infra/content-ref';
import { getAppForUser, listAppsForUser, type App } from '@tabs/software/lib/apps';
import { appBuilderEnabled } from '@core/kernel/app-builder-flag';
import { releaseConsequences } from '@tabs/software/lib/releases/consequences';
import { canReview, currentGoLiveRules, goLiveDecision, scopeOfVisibility } from '@core/policy/go-live-rules';
import type { Role } from '@core/kernel/session';
import type { Permission } from '@core/kernel/lifecycle-adapters';

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

/** Today's edit right for going live: the owner, or an in-domain domain admin / admin of a non-Personal app. */
function mayEditForGoLive(actor: LifecycleActor, a: App): boolean {
  if (a.owner === actor.id) return true;
  return a.visibility !== 'Personal' && actor.domains.includes(a.domain) && (actor.role === 'domain_admin' || actor.role === 'admin');
}

/**
 * App Builder (F, flag on): the go-live rule table decides who may change what runs for this app. Exported for the
 * integration test; the adapter calls it only with the flag on.
 */
export async function appCanGoLiveByRules(actor: LifecycleActor, a: App): Promise<Permission> {
  const rules = await currentGoLiveRules();
  const scope = scopeOfVisibility(a.visibility);
  const decision = goLiveDecision(rules, 'app', scope, a.domain);
  if (decision.autoApprove) {
    return mayEditForGoLive(actor, a)
      ? { ok: true }
      : { ok: false, reason: `only someone who may edit “${a.name}” can take it live (${decision.reason})` };
  }
  const verdict = canReview(
    rules,
    { kind: 'app', scope, domain: a.domain, requestedBy: a.owner },
    { id: actor.id, role: actor.role as Role, domains: actor.domains },
  );
  if (verdict.ok) return { ok: true };
  return {
    ok: false,
    reason: a.owner === actor.id
      ? `“${a.name}” cannot go live by its owner alone: ${decision.reason}, and nobody approves their own go-live`
      : `you cannot take “${a.name}” live: ${verdict.reason}`,
  };
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
    if (appBuilderEnabled()) return appCanGoLiveByRules(actor, a);
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
  // App Builder (W0): the Prod release's own sentences (workstream C2), only with the flag on. Off: no consequences,
  // the confirm dialog is exactly as before.
  consequences: async (actor, obj) => (appBuilderEnabled() ? releaseConsequences(await getAppForUser(obj.id, U(actor))) : []),
  existing: async () => {
    const all = await listAppsForUser(PLATFORM);
    return all.map((a) => ({ id: a.id, head: appRef(a), domain: a.domain }));
  },
};
