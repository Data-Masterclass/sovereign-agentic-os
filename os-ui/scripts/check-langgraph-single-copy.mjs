#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `@langchain/langgraph` and `@langchain/core` resolve to exactly ONE copy each
 * USER STORY: As the engine engineer I want CI to fail when a dependency pulls in a second copy of
 *             LangGraph or LangChain core: two copies have two async-context singletons, and
 *             `interrupt()` then cannot find the running graph (it throws "outside the context of
 *             a graph") — a failure that only shows up when a run pauses.
 * ARCHITECTURE: `npm ls <pkg> --all --parseable` prints one install path per physical copy (a
 *             deduped dependency is printed once). More than one path, or none, fails. Run from os-ui.
 */
import { spawnSync } from 'node:child_process';

const PACKAGES = ['@langchain/langgraph', '@langchain/core'];
let failed = false;
for (const pkg of PACKAGES) {
  const r = spawnSync('npm', ['ls', pkg, '--all', '--parseable'], { encoding: 'utf8' });
  const paths = [...new Set((r.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l.includes('node_modules')))];
  if (paths.length !== 1) {
    failed = true;
    console.error(`check-langgraph-single-copy: FAIL — ${pkg} has ${paths.length} copies:\n  ${paths.join('\n  ') || '(not installed)'}`);
  } else {
    console.log(`check-langgraph-single-copy: ok — ${pkg} has one copy (${paths[0].split('node_modules/').pop()})`);
  }
}
process.exit(failed ? 1 : 0);
