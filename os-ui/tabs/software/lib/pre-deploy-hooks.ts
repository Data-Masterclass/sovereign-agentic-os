/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (W0) - the pre-deploy hook registry (migrations run before a rollout)
 * USER STORY: As the owner of a release path I want the steps that must succeed before a rollout (database
 *             migrations first) to plug in by name, so the deploy code never imports the database code and a
 *             failed step stops the rollout with its reason.
 * ARCHITECTURE:
 *   - Workstream D registers (`registerPreDeployHook('migrations', …)`), workstream C2 calls `runPreDeployHooks`
 *     before every rollout to `apps-dev`/`apps-prod`. Hooks run in registration order; the FIRST refusal stops the
 *     run and is returned, named by its hook (later hooks do not run). A hook that throws is a refusal carrying
 *     the error message.
 *   - No hooks ⇒ `{ ok: true, applied: [] }`. Registering the same name twice replaces the earlier hook in place
 *     (module reloads in dev and tests stay idempotent).
 *   - The registry lives on globalThis so the Next dev server's module copies share one list.
 */
import type { AppEnv } from '@tabs/software/lib/app-builder-contracts';

export type PreDeployInput = { slug: string; domain: string; env: AppEnv; namespace: string; image: string; sha: string };
export type PreDeployResult = { ok: true; applied: string[] } | { ok: false; reason: string };
export type PreDeployHook = (i: PreDeployInput) => Promise<PreDeployResult>;

const KEY = Symbol.for('soa.software.preDeployHooks');
type Registry = Map<string, PreDeployHook>;
const registry = (): Registry => {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (g[KEY] ??= new Map());
};

export function registerPreDeployHook(name: string, h: PreDeployHook): void {
  if (!name.trim()) throw new Error('a pre-deploy hook needs a name');
  registry().set(name, h);
}

export function preDeployHookNames(): string[] {
  return [...registry().keys()];
}

/** Run every hook in order; `applied` concatenates what each reported. The first refusal wins, prefixed by its name. */
export async function runPreDeployHooks(i: PreDeployInput): Promise<PreDeployResult> {
  const applied: string[] = [];
  for (const [name, h] of registry()) {
    let r: PreDeployResult;
    try {
      r = await h(i);
    } catch (e) {
      r = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    if (!r.ok) return { ok: false, reason: `${name}: ${r.reason}` };
    applied.push(...r.applied);
  }
  return { ok: true, applied };
}

/** Tests only. */
export function __resetPreDeployHooks(): void {
  registry().clear();
}
