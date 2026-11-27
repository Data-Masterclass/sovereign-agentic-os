/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    App Builder (E) - the Software tab's answer to "which app is this, and what may it do?" for the
 *             kernel's app identity token (core/auth/app-token.ts AppTokenPort).
 * USER STORY: As a user signing in to an app I want the OS to check that I may see that app, send me back only to
 *             that app's own registered hosts, and give it exactly its granted reads, agents and declared actions.
 * ARCHITECTURE:
 *   - Lives beside `instrumentation.ts` (the one place allowed to know both the kernel and the tabs, like
 *     `opa-state-sources.ts`); `instrumentation.ts` registers it at boot. The kernel never imports a tab.
 *   - Only App Builder apps (`templateVersion: 2`, not archived) are resolvable: v1 apps keep the OS-rendered
 *     session path and never get a token. Visibility is the Software tab's own `getAppForUser` rule, applied to the
 *     user's LIVE principal on every call.
 *   - Audience = the contracts' `appAudience(domain, slug, env)`. Callback hosts (spec 2b / 6.5): prod
 *     `<slug>.<domain>.<appsDomain>`; dev `<slug>.<domain>.dev.<appsDomain>` and the preview slots
 *     `<slug>-p1|p2.<domain>.dev.<appsDomain>`; a label over 63 characters is cut and given the 8-hex app hash.
 *     Hosts must be one app's alone: a domain id that is not a DNS label gets none (never a lossy mapping), and a
 *     host two apps of one domain would both derive is removed from both (`exclusiveCallbackHosts`).
 *   - Declared write actions come from the app's `actions.yml` at its current tree (the same parse the app tool
 *     door uses), so a deploy that adds an action widens the scope and the next login asks again.
 */
import 'server-only';
import { registerAppTokenPort, type AppPrincipal, type AppTokenApp, type AppTokenPort } from '@core/auth/app-token';
import type { CurrentUser } from '@core/kernel/auth';
import type { Role } from '@core/kernel/session';
import { config } from '@core/kernel/config';
import { getAppByDomainSlugInternal, getAppBySlugForUser, getAppForUser, listAllAppsInternal, templateVersionOf, type App } from '@tabs/software/lib/apps';
import { appAudience, appNameHash } from '@tabs/software/lib/app-builder-contracts';
import { parseAppActions } from '@tabs/software/lib/app-actions';
import { getSnapshot, hydrateSnapshot } from '@tabs/software/lib/snapshot';
import { availableContext } from '@tabs/software/lib/available-context';

const asUser = (p: AppPrincipal): CurrentUser => ({ id: p.id, name: p.name, domains: p.domains, allDomains: p.domains, activeDomain: null, role: p.role as Role });

/**
 * One DNS label from a slug (+ optional preview slot): at most 63 characters, the 8-hex app hash when it had to be cut.
 * A slot is appended with `--` (security review of #400): a slug never contains `--` (slugify collapses dashes) and an
 * env label is a slug or `<cut slug>-<h8>`, so no slot label can ever equal any app's env label (app `orders`'s slot
 * `orders--p1` vs app `orders-p1`'s Dev host `orders-p1`). A two-character slug would put `--` at positions 3-4 (the
 * reserved R-LDH form), so it takes the hashed form. Kept in lockstep with tabs/software/lib/releases/overlay.ts (a test pins it).
 */
export function appHostLabel(domain: string, slug: string, slot?: 'p1' | 'p2'): string {
  if (!slot) {
    if (slug.length <= 63) return slug;
    const tail = `-${appNameHash(domain, slug)}`;
    return `${slug.slice(0, 63 - tail.length).replace(/-+$/, '')}${tail}`;
  }
  const full = `${slug}--${slot}`;
  if (full.length <= 63 && slug.length !== 2) return full;
  const tail = `-${appNameHash(domain, slug)}--${slot}`;
  return `${slug.slice(0, 63 - tail.length).replace(/-+$/, '')}${tail}`;
}

/**
 * A domain id that IS a DNS label, used as is. Nothing is lowercased, collapsed or cut: such a mapping would let two
 * domains (`Sales_EU`, `sales-eu`) share a host and receive each other's sign-in codes. A domain id that is not a DNS
 * label gets no callback host at all, so its apps cannot use app sign-in (fail closed).
 */
export const isDnsLabelDomain = (domain: string): boolean => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain);

/** The registered callback hosts of an app per env, or null when its domain id is not a DNS label. */
export function appCallbackHosts(domain: string, slug: string, appsDomain: string = config.appsBaseDomain): AppTokenApp['callbackHosts'] | null {
  if (!isDnsLabelDomain(domain)) return null;
  const d = domain;
  return {
    prod: [`${appHostLabel(domain, slug)}.${d}.${appsDomain}`],
    dev: [`${appHostLabel(domain, slug)}.${d}.dev.${appsDomain}`, `${appHostLabel(domain, slug, 'p1')}.${d}.dev.${appsDomain}`, `${appHostLabel(domain, slug, 'p2')}.${d}.dev.${appsDomain}`],
  };
}

/**
 * Callback hosts that belong to this app ALONE. Slot labels (`x--p1`) can no longer meet an env label, so this is
 * defence in depth against any future shape collision: a host that any other app of the domain also derives is removed from
 * BOTH apps, so a code can never be delivered to a host another app serves. Null when the domain is not a DNS label.
 */
export function exclusiveCallbackHosts(app: Pick<App, 'id' | 'domain' | 'slug'>, others: Pick<App, 'id' | 'domain' | 'slug'>[], appsDomain: string = config.appsBaseDomain): AppTokenApp['callbackHosts'] | null {
  const mine = appCallbackHosts(app.domain, app.slug, appsDomain);
  if (!mine) return null;
  const taken = new Set<string>();
  for (const o of others) {
    if (o.id === app.id || o.domain !== app.domain) continue;
    const h = appCallbackHosts(o.domain, o.slug, appsDomain);
    if (h) for (const x of [...h.dev, ...h.prod]) taken.add(x);
  }
  return { dev: mine.dev.filter((x) => !taken.has(x)), prod: mine.prod.filter((x) => !taken.has(x)) };
}

const READ_KINDS = ['data', 'metrics', 'knowledge', 'files'] as const;

/** The kernel's view of an app (names resolved only when asked: the consent screen); null without callback hosts. */
export async function appTokenView(app: App, user: CurrentUser, withNames = false): Promise<AppTokenApp | null> {
  const callbackHosts = exclusiveCallbackHosts(app, await listAllAppsInternal());
  if (!callbackHosts) return null;
  await hydrateSnapshot(app.id);
  const actions = parseAppActions(getSnapshot(app.id) ?? []).actions;
  let names: Awaited<ReturnType<typeof availableContext>> = {};
  if (withNames) {
    const kinds = READ_KINDS.filter((k) => app.grants[k].length > 0);
    names = kinds.length ? await availableContext({ ...user, activeDomain: null }, [...kinds]) : {};
  }
  return {
    id: app.id,
    name: app.name,
    domain: app.domain,
    slug: app.slug,
    audience: { dev: appAudience(app.domain, app.slug, 'dev'), prod: appAudience(app.domain, app.slug, 'prod') },
    callbackHosts,
    reads: READ_KINDS.flatMap((kind) =>
      app.grants[kind].map((g) => ({ kind, id: g.id, name: names[kind]?.find((i) => i.id === g.id)?.name ?? g.id })),
    ),
    agents: (app.agents ?? []).map((a) => ({ id: a.id, name: a.id })),
    writeActions: actions.filter((a) => a.write).map((a) => ({ name: a.name, description: a.description, scopes: [...a.scopes] })),
    recordsDeclared: actions.some((a) => a.scopes.includes('records')),
  };
}

export const appTokenPortImpl: AppTokenPort = {
  async appFor(principal, domain, slug, opts) {
    const candidate = await getAppByDomainSlugInternal(domain, slug);
    if (!candidate || candidate.status === 'archived' || templateVersionOf(candidate) !== 2) return null;
    const user = asUser(principal);
    let app: App;
    try {
      app = await getAppForUser(candidate.id, user); // the Software tab's own visibility rule
    } catch {
      return null;
    }
    return appTokenView(app, user, opts?.withNames === true);
  },
  async bySlugFor(principal, slug) {
    const app = await getAppBySlugForUser(slug, asUser(principal));
    return app?.id ?? null;
  },
};

/** Install the port (instrumentation.ts, web process). */
export function registerAppTokenSources(): void {
  registerAppTokenPort(appTokenPortImpl);
}
