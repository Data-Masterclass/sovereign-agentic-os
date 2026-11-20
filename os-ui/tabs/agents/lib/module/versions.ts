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
 */
import { createRequire } from 'node:module';
import { MODULE_PACKAGES, type ModuleVersions } from '@tabs/agents/lib/module/generate';

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
