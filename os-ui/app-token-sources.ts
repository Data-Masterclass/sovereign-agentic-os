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
 *   - Declared write actions come from the app's `actions.yml` at its current tree (the same parse the app tool
 *     door uses), so a deploy that adds an action widens the scope and the next login asks again.
 */
import 'server-only';
import { registerAppTokenPort, type AppPrincipal, type AppTokenApp, type AppTokenPort } from '@core/auth/app-token';
import type { CurrentUser } from '@core/kernel/auth';
import type { Role } from '@core/kernel/session';
import { config } from '@core/kernel/config';
import { getAppByDomainSlugInternal, getAppBySlugForUser, getAppForUser, templateVersionOf, type App } from '@tabs/software/lib/apps';
import { appAudience, appNameHash } from '@tabs/software/lib/app-builder-contracts';
import { parseAppActions } from '@tabs/software/lib/app-actions';
import { getSnapshot, hydrateSnapshot } from '@tabs/software/lib/snapshot';
import { availableContext } from '@tabs/software/lib/available-context';

const asUser = (p: AppPrincipal): CurrentUser => ({ id: p.id, name: p.name, domains: p.domains, allDomains: p.domains, activeDomain: null, role: p.role as Role });

/** One DNS label from a slug (+ optional suffix): at most 63 characters, the 8-hex hash when it had to be cut. */
export function appHostLabel(domain: string, slug: string, suffix?: 'p1' | 'p2'): string {
  const full = suffix ? `${slug}-${suffix}` : slug;
  if (full.length <= 63) return full;
  const tail = `-${appNameHash(domain, slug)}${suffix ? `-${suffix}` : ''}`;
  return `${slug.slice(0, 63 - tail.length).replace(/-+$/, '')}${tail}`;
}

/** The domain as a DNS label (a domain id may carry `.`, `_` or capitals). */
const domainLabel = (domain: string) => domain.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);

/** The registered callback hosts of an app per env. */
export function appCallbackHosts(domain: string, slug: string, appsDomain: string = config.appsBaseDomain): AppTokenApp['callbackHosts'] {
  const d = domainLabel(domain);
  return {
    prod: [`${appHostLabel(domain, slug)}.${d}.${appsDomain}`],
    dev: [`${appHostLabel(domain, slug)}.${d}.dev.${appsDomain}`, `${appHostLabel(domain, slug, 'p1')}.${d}.dev.${appsDomain}`, `${appHostLabel(domain, slug, 'p2')}.${d}.dev.${appsDomain}`],
  };
}

const READ_KINDS = ['data', 'metrics', 'knowledge', 'files'] as const;

/** The kernel's view of an app (names resolved only when asked: the consent screen). */
export async function appTokenView(app: App, user: CurrentUser, withNames = false): Promise<AppTokenApp> {
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
    callbackHosts: appCallbackHosts(app.domain, app.slug),
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
