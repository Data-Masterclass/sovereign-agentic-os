/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    The agent system's lifecycle adapter — a schedule runs the PINNED definition
 * USER STORY: As the person on call I need to know which version of an agent system the 3 a.m.
 *             run executed. Today it is whatever the head happened to be when the CronJob fired,
 *             so every incident starts with an archaeology problem.
 * ARCHITECTURE:
 *   - An agent system IS git-backed (`agents/**`, committed by `commitAgentSystem`), so its
 *     lifecycle ref is the real commit sha from `systemGitInfo(...).head.sha` and the pinned
 *     definition is `readBlob(domain, pin.ref, pin.path)` — the bytes in the repo, not a copy.
 *   - The pinned PATH is recorded with the pin, because `placeSystems` derives a directory from
 *     the current set of systems: resolving the path again later could point at a directory that
 *     has since moved. `scheduledSystemYaml` is the one function the scheduled-run door calls.
 *   - FAIL CLOSED, LOUDLY: if a pin exists but its blob cannot be read, the scheduled run is
 *     refused with the reason. It does NOT fall back to the head — running a different version
 *     than the one that was signed off is exactly the failure a pin exists to prevent.
 *   - Studio runs the HEAD: trying something out must never need a go-live.
 *   - Imports only `@core/*` and this tab; registration happens at boot in instrumentation.ts.
 *   - CROSS-STREAM (deviation V-7): stream G landed `core/infra/git-objects.ts` with
 *     `objectGitInfo(kind, id)` and ONE kind+layout table on branch `night2/G`, which is not in
 *     this branch. Once it merges, `systemYamlPath` and the `systemGitInfo` call in `resolve`
 *     must both be replaced by `objectGitInfo('agent', id)` so there is a single layout table.
 *     Nothing above this file changes: the pin already treats the ref and path as opaque.
 */
import 'server-only';

import type { LifecycleAdapter, LifecycleActor, DependencyRef } from '@core/kernel/lifecycle-adapters';
import { livePin } from '@core/infra/lifecycle-pins';
import { readBlob } from '@core/infra/git-store';
import { config } from '@core/kernel/config';
import { getSystem, listAllSystemsInternal, systemForScheduler, type Principal } from '@tabs/agents/lib/store';
import { parseSystem, type Grants, type ArtifactGrant } from '@tabs/agents/lib/system-schema';
import { systemGitInfo } from '@tabs/agents/lib/git/history';
import { placeSystems } from '@tabs/agents/lib/git/generate';
import { projectSnapshot } from '@tabs/agents/lib/git/snapshot';

const P = (a: LifecycleActor): Principal => ({ id: a.id, domains: a.domains, role: a.role as Principal['role'] });

/** The repo path of one system's `system.yaml` in its domain's current layout. */
export async function systemYamlPath(domain: string, systemId: string): Promise<string | undefined> {
  const snapshot = await projectSnapshot(domain);
  const placed = placeSystems(snapshot).find((p) => p.system.id === systemId);
  return placed ? `${placed.dir}/system.yaml` : undefined;
}

/** Which grant kinds are lifecycle-bearing dependencies, and what kind each one is. */
const GRANT_KINDS: { field: keyof Grants; kind: 'dataset' | 'knowledge' | 'metric' | 'connection' }[] = [
  { field: 'data', kind: 'dataset' },
  { field: 'metrics', kind: 'metric' },
  { field: 'knowledge', kind: 'knowledge' },
  { field: 'connections', kind: 'connection' },
];

/**
 * An agent system's dependencies are its GRANTED RESOURCES — the things it reads and writes.
 * Folder grants are excluded: a folder is not an object with a version to pin.
 */
export function grantedDependencies(grants: Grants): DependencyRef[] {
  const out: DependencyRef[] = [];
  for (const { field, kind } of GRANT_KINDS) {
    const list = (grants[field] ?? []) as ArtifactGrant[];
    for (const g of list) {
      if (!g?.id || g.folder) continue;
      if (g.capability === 'Off' || g.capability === 'Blocked') continue;
      out.push({ kind, id: g.id, name: g.id });
    }
  }
  return out;
}

export type ScheduledYaml =
  | { ok: true; yaml: string; source: 'pin'; ref: string }
  | { ok: false; error: string; status: number };

/**
 * The definition a SCHEDULED run must execute: the pinned one, or a refusal.
 *
 * A system with no pin is not live, so nothing should be scheduling it — the refusal says so
 * rather than quietly running a draft on a cron. A pin whose blob cannot be read is also a
 * refusal: never a different version than the one that was taken live.
 */
export async function scheduledSystemYaml(
  systemId: string,
  deps: { reposDir?: string } = {},
): Promise<ScheduledYaml> {
  const rec = systemForScheduler(systemId);
  if (!rec) return { ok: false, error: 'system not found', status: 404 };
  const pin = await livePin('agent', systemId);
  if (!pin) {
    return {
      ok: false,
      error: `“${systemId}” is not live, so its schedule has nothing pinned to run — go live with a version first, or run it from Studio`,
      status: 409,
    };
  }
  const path = pin.path ?? (await systemYamlPath(rec.domain, systemId));
  if (!path) {
    return {
      ok: false,
      error: `the live version of “${systemId}” records no file in the repo, so the pinned definition cannot be read`,
      status: 409,
    };
  }
  try {
    const yaml = await readBlob(rec.domain, pin.ref, path, { reposDir: deps.reposDir ?? config.reposDir });
    return { ok: true, yaml, source: 'pin', ref: pin.ref };
  } catch (e) {
    return {
      ok: false,
      error: `the live version of “${systemId}” (${pin.ref}) could not be read from the repo: ${
        (e as Error).message
      }. The schedule is refused rather than running a different version.`,
      status: 409,
    };
  }
}

export const agentLifecycleAdapter: LifecycleAdapter = {
  kind: 'agent',
  resolve: async (actor, id) => {
    const view = getSystem(id, P(actor)); // throws 403/404 as the caller
    const git = await systemGitInfo(view.domain, id);
    const path = await systemYamlPath(view.domain, id);
    return {
      kind: 'agent',
      id: view.id,
      name: view.name,
      domain: view.domain,
      head: git?.head?.sha ?? '',
      tier: view.visibility,
      ...(path ? { path } : {}),
    };
  },
  canGoLive: async (actor, obj) => {
    const view = getSystem(obj.id, P(actor));
    if (view.owner === actor.id) return { ok: true };
    if (view.visibility !== 'Personal' && (actor.role === 'domain_admin' || actor.role === 'admin')) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `only ${view.owner} (or a domain admin on a shared agent system) may change what runs for “${view.name}”`,
    };
  },
  dependencies: async (actor, obj) => grantedDependencies(getSystem(obj.id, P(actor)).system.grants),
  consequences: async (actor, obj) => {
    const view = getSystem(obj.id, P(actor));
    const out: string[] = [];
    if (view.schedule?.kind === 'cron' && view.schedule.cron) {
      out.push(`its schedule (${view.schedule.cron} UTC) runs this pinned system.yaml, as ${view.owner}`);
    } else if (view.schedule?.kind === 'event' && view.schedule.event) {
      out.push(`the event “${view.schedule.event}” runs this pinned system.yaml, as ${view.owner}`);
    } else {
      out.push('nothing is scheduled for it, so Run only shows it until you add a schedule');
    }
    const deps = grantedDependencies(view.system.grants).length;
    if (deps) out.push(`it keeps its ${deps} granted resource${deps === 1 ? '' : 's'}, at the caller's own access`);
    return out;
  },
  existing: async () => {
    const out: { id: string; head: string; domain: string }[] = [];
    for (const s of listAllSystemsInternal()) {
      const rec = systemForScheduler(s.id);
      if (!rec) continue;
      const git = await systemGitInfo(rec.domain, s.id);
      out.push({ id: s.id, head: git?.head?.sha ?? '', domain: rec.domain });
    }
    return out;
  },
};
