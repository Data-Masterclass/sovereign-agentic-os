/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (C2) - roll an env back to the release before, told honestly what that means for the database
 * USER STORY: As an app owner I want one action that puts the previous release back in Dev or Prod, and I want to be
 *             told which migrations stay applied, because the older code then runs against the newer schema.
 * ARCHITECTURE: (spec 6.3 "Rollback", 9)
 *   - Rollback = a NEW release of the previous release's sha and digest (no rebuild), through rollout.ts with NO
 *     pre-deploy hooks (no migration runs: migrations are forward-only and stay applied); the release rolled back from
 *     is marked `rolled-back` once the new one runs.
 *   - `rollbackPlan` (pure) is what the card shows before anyone confirms: target, current, and the migrations applied
 *     by every release after the target, with the expand/contract warning.
 *   - Rights: Dev = the app's editors; Prod = the go-live right of the app's scope (Platform rule table, spec 9), the
 *     same check as changing Prod env (lib/appdb/access.ts `prodWriteRefusal`). The callers (route, MCP) check it.
 */
import 'server-only';
import type { AppEnv, AppRelease } from '@tabs/software/lib/app-builder-contracts';
import type { App } from '@tabs/software/lib/apps';
import { releasesOf, rollbackTarget, saveRelease, transition, currentRelease } from '@tabs/software/lib/releases/store';
import { rolloutRelease, type RolloutDeps, type RolloutResult } from '@tabs/software/lib/releases/rollout';

export const ROLLBACK_WARNING =
  'Migrations are forward-only: every migration listed stays applied, and the older code runs against the newer schema. ' +
  'That is safe only when each change followed the expand/contract rule (docs/rules/own-database.md).';

export type RollbackPlan = { env: AppEnv; current: AppRelease; target: AppRelease; migrationsSince: string[]; warning: string };

/** Pure: what a rollback of `env` would do, or null when there is nothing to roll back to. */
export function rollbackPlan(app: Pick<App, 'releases'>, env: AppEnv): RollbackPlan | null {
  const current = currentRelease(app, env);
  const target = rollbackTarget(app, env);
  if (!current || !target) return null;
  const since = releasesOf(app, env).filter((r) => r.at > target.at && r.at <= current.at && r.migrations.status === 'ok');
  const migrationsSince = [...new Set(since.flatMap((r) => r.migrations.applied))];
  return { env, current, target, migrationsSince, warning: ROLLBACK_WARNING };
}

export type RollbackResult = { ok: true; plan: RollbackPlan; rollout: Extract<RolloutResult, { ok: true }> } | { ok: false; status: number; reason: string; rollout?: RolloutResult };

export async function rollbackApp(app: App, env: AppEnv, by: { id: string; name?: string }, deps: RolloutDeps = {}): Promise<RollbackResult> {
  const plan = rollbackPlan(app, env);
  if (!plan) return { ok: false, status: 409, reason: `there is no earlier ${env} release with a different image to roll back to` };
  const out = await rolloutRelease(app, { env, sha: plan.target.sha, digest: plan.target.digest, by, reason: 'rollback', skipHooks: true }, deps);
  if (!out.ok) return { ok: false, status: out.code === 'no_builder' ? 503 : 409, reason: out.reason, rollout: out };
  const fresh = (app.releases ?? []).find((r) => r.id === plan.current.id);
  if (fresh && fresh.state === 'running') await saveRelease(app, transition(fresh, 'rolled-back'), by, deps);
  return { ok: true, plan, rollout: out };
}
