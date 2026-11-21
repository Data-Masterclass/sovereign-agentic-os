/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The npm versions an ejected agent module pins: the ones this os-ui actually runs
 * USER STORY: As an AI engineer I want `npm install` beside `graph.mjs` to give me exactly the
 *             LangGraph, langchain and OpenAI client versions the OS ran my team with.
 * ARCHITECTURE:
 *   - ONE source: os-ui's own `package-lock.json`, read from a KNOWN PATH (`OS_UI_LOCKFILE`, set in
 *     the image to /app/package-lock.json; a checkout uses `<cwd>/package-lock.json`). `npm ci`
 *     installed exactly that lockfile, so its entries are the versions os-ui runs. No module
 *     resolution at all (WP-53e): in the bundled server `require.resolve` returns a webpack module
 *     id, not a path, and every agent-definition commit failed on it.
 *   - The versions are the lockfile's top-level `node_modules/<pkg>` entries; the sub-dependencies
 *     are pinned from the same lockfile (the generator keeps the closure of the module's packages),
 *     so `npm ci` beside `run.mjs` installs exactly the tree os-ui runs. Nothing is hard-coded.
 */
import { existsSync, readFileSync } from 'node:fs';
import { config } from '@core/kernel/config';
import { MODULE_PACKAGES, type HostLock, type ModuleVersions } from '@tabs/agents/lib/module/generate';

/** os-ui's lockfile, from its known path. Throws (naming the path) when it is missing or unreadable. */
export function hostLockfile(file: string = config.agentModuleHostLockfile): HostLock {
  if (!existsSync(file)) throw new Error(`no package-lock.json at ${file} (OS_UI_LOCKFILE) — the module's dependencies cannot be pinned`);
  const lock = JSON.parse(readFileSync(file, 'utf8')) as HostLock;
  if (!lock || typeof lock.packages !== 'object' || lock.packages === null) throw new Error(`${file} is not an npm lockfile (no "packages")`);
  return lock;
}

/** The exact version of each module package os-ui runs, from the lockfile's top-level entries. */
export function installedModuleVersions(lock: HostLock = hostLockfile()): ModuleVersions {
  const out = {} as ModuleVersions;
  for (const p of MODULE_PACKAGES) {
    const v = lock.packages[`node_modules/${p}`]?.version;
    if (typeof v !== 'string' || !v) throw new Error(`no installed version for ${p} in os-ui's lockfile`);
    (out as Record<string, string>)[p] = v;
  }
  return out;
}

/** The generator's host inputs: exact versions and the lockfile they come from. */
export function hostModuleInputs(file?: string): { versions: ModuleVersions; hostLock: HostLock } {
  const hostLock = hostLockfile(file);
  return { versions: installedModuleVersions(hostLock), hostLock };
}
