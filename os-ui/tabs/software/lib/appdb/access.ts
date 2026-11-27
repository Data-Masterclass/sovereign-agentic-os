/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - who may see and change an app's database, env and secrets per env
 * USER STORY: As an app owner I change Dev env freely; as the owner I want Prod env changed only by someone who may
 *             also take the app live in Prod.
 * ARCHITECTURE: (spec 7 "Env and secrets", 9)
 *   - Reading names and states: anyone who may EDIT the app (`getEditableAppForUser`: owner, in-domain domain admin,
 *     admin; fail closed). A value is never returned to anyone.
 *   - Writing Dev: the same editors. Writing Prod: the right to go live in the app's scope under the Platform rule
 *     table (W0 `goLiveDecision` / `canReview`): reviewer `none` ⇒ an editor may; otherwise the user's role must be at
 *     least the row's reviewer and, below admin, in the app's domain. There is no requester here, so the "nobody
 *     approves their own go-live" invariant does not apply (it governs a request someone else decides).
 *   - An app token never reaches these: the routes are not on the app token allowlist, and `via` is refused anyway.
 *   - Pure decision (`prodWriteRefusal`) + a loader; the rule table is read on every call (`currentGoLiveRules`).
 */
import type { CurrentUser } from '@core/kernel/auth';
import { canReview, currentGoLiveRules, goLiveDecision, scopeOfVisibility, type GoLiveRule } from '@core/policy/go-live-rules';
import type { AppEnv } from '@tabs/software/lib/app-builder-contracts';
import type { App } from '@tabs/software/lib/apps';

const withStatus = (e: Error, status: number) => Object.assign(e, { status });

/** Null when `user` may change `app`'s Prod database/env under `rules`; else the reason. */
export function prodWriteRefusal(rules: readonly GoLiveRule[], app: Pick<App, 'visibility' | 'domain'>, user: Pick<CurrentUser, 'id' | 'role' | 'domains'> & { allDomains?: string[] }): string | null {
  const scope = scopeOfVisibility(app.visibility);
  const d = goLiveDecision(rules, 'app', scope, app.domain);
  if (d.autoApprove) return null;
  // Membership is every domain the user belongs to, not the active-domain narrowing of `domains`.
  const member = { id: user.id, role: user.role, domains: user.allDomains?.length ? user.allDomains : user.domains };
  const v = canReview(rules, { kind: 'app', scope, domain: app.domain, requestedBy: '' }, member);
  return v.ok ? null : `changing Prod needs the right to take this app live in Prod: ${v.reason}`;
}

/** The app, if `user` may edit it (404 unseeable, 403 not an editor); refuses an app token caller. */
export async function editableApp(appId: string, user: CurrentUser): Promise<App> {
  if (user.via) throw withStatus(new Error('not available to an app'), 403);
  const { getEditableAppForUser } = await import('@tabs/software/lib/apps');
  return getEditableAppForUser(appId, user);
}

/** Throws 403 unless `user` may write `env` of `app` (Dev: editor, already checked by `editableApp`; Prod: the go-live right). */
export async function assertEnvWrite(app: App, user: CurrentUser, env: AppEnv, rules?: readonly GoLiveRule[]): Promise<void> {
  if (env !== 'prod') return;
  const why = prodWriteRefusal(rules ?? (await currentGoLiveRules()), app, user);
  if (why) throw withStatus(new Error(why), 403);
}

export function parseEnv(v: unknown): AppEnv {
  if (v === 'dev' || v === 'prod') return v;
  throw withStatus(new Error('env must be "dev" or "prod"'), 400);
}
