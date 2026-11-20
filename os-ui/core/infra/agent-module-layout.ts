/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Where an agent system's native LangGraph module lives inside its directory
 * USER STORY: As an AI engineer I want every agent system to sit in the repo as a folder I can run
 *             with plain Node — `graph.mjs`, `run.mjs`, `prompts/`, `evals/`, `README.md` — at the
 *             same paths in every repo (component-design 12, `agents/<system>/…`).
 * ARCHITECTURE:
 *   - ONE local constant set (WP-53). WP-55 publishes `core/infra/repo-layout.ts` as the single
 *     path module for every repo path; when it merges, these names move there and this file goes.
 *   - Paths are RELATIVE to the system's directory (`agents/<slug>` or the personal lane, which
 *     `git/generate.ts` `placeSystems` decides). Nothing here builds the directory itself.
 */

/** The generated LangGraph JS module (the code that runs). */
export const MODULE_GRAPH = 'graph.mjs';
/** The ejector: runs `graph.mjs` with a model URL and key and local tools, no OS present. */
export const MODULE_RUNNER = 'run.mjs';
/** Pinned npm dependencies for `npm ci` / `npm install` beside the module. */
export const MODULE_PACKAGE = 'package.json';
/** One system prompt per agent: `prompts/<agent id>.md`. */
export const MODULE_PROMPTS_DIR = 'prompts';
/** Example inputs an engineer can replay: `evals/cases.json`. */
export const MODULE_EVALS = 'evals/cases.json';

/** The prompt file of one agent, relative to the system directory. */
export function promptPath(agentId: string): string {
  return `${MODULE_PROMPTS_DIR}/${agentId}.md`;
}

/**
 * The files the OS LOADS and therefore hash-verifies before import: the graph and every prompt it
 * reads. `run.mjs`, `package.json`, `evals/` and `README.md` are generated too, but the OS never
 * executes them.
 */
export function isLoadedModuleFile(relPath: string): boolean {
  return relPath === MODULE_GRAPH || (relPath.startsWith(`${MODULE_PROMPTS_DIR}/`) && relPath.endsWith('.md'));
}
