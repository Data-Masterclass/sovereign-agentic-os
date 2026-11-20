/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The npm versions an ejected agent module pins: the ones this os-ui actually runs
 * USER STORY: As an AI engineer I want `npm install` beside `graph.mjs` to give me exactly the
 *             LangGraph, langchain and OpenAI client versions the OS ran my team with.
 * ARCHITECTURE:
 *   - Read from the INSTALLED packages' own `package.json` (`createRequire` from this file), so the
 *     pin is what is loaded, not a copy of a version string. No version is hard-coded here.
 *   - The sub-dependencies are pinned from os-ui's own `package-lock.json`, found beside the
 *     `node_modules` the packages resolve from (the image copies it there): the generator keeps
 *     the closure of the module's packages, so `npm ci` beside `run.mjs` installs exactly the tree
 *     os-ui runs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { MODULE_PACKAGES, type HostLock, type ModuleVersions } from '@tabs/agents/lib/module/generate';

export function installedModuleVersions(): ModuleVersions {
  const req = createRequire(import.meta.url);
  const v = (pkg: { version: string }) => String(pkg.version);
  const out: ModuleVersions = {
    '@langchain/core': v(req('@langchain/core/package.json')),
    '@langchain/langgraph': v(req('@langchain/langgraph/package.json')),
    '@langchain/langgraph-checkpoint-postgres': v(req('@langchain/langgraph-checkpoint-postgres/package.json')),
    '@langchain/openai': v(req('@langchain/openai/package.json')),
    langchain: v(req('langchain/package.json')),
  };
  for (const p of MODULE_PACKAGES) if (!out[p]) throw new Error(`no installed version for ${p}`);
  return out;
}

/** os-ui's lockfile: beside the `node_modules` that `@langchain/langgraph` resolves from. */
export function hostLockfile(): HostLock {
  const pkg = createRequire(import.meta.url).resolve('@langchain/langgraph/package.json');
  const marker = `${path.sep}node_modules${path.sep}`;
  const root = pkg.slice(0, pkg.lastIndexOf(marker));
  const file = path.join(root, 'package-lock.json');
  if (!existsSync(file)) throw new Error(`no package-lock.json beside ${root}${path.sep}node_modules — the module's sub-dependencies cannot be pinned`);
  return JSON.parse(readFileSync(file, 'utf8')) as HostLock;
}

/** The generator's host inputs: exact versions and the lockfile they come from. */
export function hostModuleInputs(): { versions: ModuleVersions; hostLock: HostLock } {
  return { versions: installedModuleVersions(), hostLock: hostLockfile() };
}
