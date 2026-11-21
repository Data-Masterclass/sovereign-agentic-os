/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Load the committed `graph.mjs` — only after its bytes match what the OS generates
 * USER STORY: As the owner I want the OS to run exactly the LangGraph module that is in git, and I
 *             want a `graph.mjs` someone edited or pushed by hand to be REFUSED, never executed, so
 *             code that did not come from the generator cannot run inside os-ui (contract C4, C5).
 * ARCHITECTURE:
 *   - Input: the module files read from the domain repo AT ONE COMMIT (`readCommittedModule`, via
 *     `core/infra/git-store.ts` `readFilesAt`) and the files the generator produces from the
 *     system's definition. Every file the OS loads (`graph.mjs` + `prompts/*.md`, see
 *     `core/infra/repo-layout.ts`) must be present in the commit with the SAME sha256; one missing, extra
 *     or different file is `AgentModuleIntegrityError` and nothing is imported.
 *   - The verified bytes are written to `<cacheRoot>/<digest>/` (content-addressed: the digest is
 *     sha256 over the sorted `path sha256` lines), and imported from there with a dynamic
 *     `import()`. `<cacheRoot>/node_modules` links to os-ui's own `node_modules`, so the module
 *     resolves `@langchain/langgraph` and `langchain` to the SAME copies os-ui uses (one copy is
 *     what `interrupt()`'s async context needs — `scripts/check-langgraph-single-copy.mjs`).
 *   - The result names the commit and the digest it loaded, so the run records what ran.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostLockfilePath } from '@core/kernel/host-lockfile';
import { readFilesAt, type GitStoreOptions } from '@core/infra/git-store';
import type { Fetched } from '@core/adapters/_contract';
import { isLoadedAgentModuleFile as isLoadedModuleFile, AGENT_GRAPH_FILE as MODULE_GRAPH } from '@core/infra/repo-layout';

/** What a loaded `graph.mjs` exports (the generator's contract). */
export type LoadedGraphModule = {
  TEAM: { name: string; entrypoint: string; agents: { id: string; model: string | null; tools: string[]; members: string[]; sets: string[] }[] };
  TOOL_NAMES: string[];
  buildGraph: (opts: {
    model: unknown;
    tools: Record<string, unknown> | unknown[];
    middleware?: unknown[] | ((agent: { id: string }) => unknown[]);
    checkpointer?: unknown;
    maxSteps?: number;
  }) => import('@langchain/langgraph').CompiledStateGraph<any, any, any, any, any, any>;
};

export type LoadedAgentModule = { module: LoadedGraphModule; digest: string; commit: string | null; dir: string };

export class AgentModuleIntegrityError extends Error {
  status = 409;
  code = 'agent_module_tampered';
  problems: string[];
  constructor(problems: string[]) {
    super(`refusing to load graph.mjs: the committed module is not what the OS generates (${problems.join('; ')})`);
    this.name = 'AgentModuleIntegrityError';
    this.problems = problems;
  }
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** sha256 over the sorted `path sha256` lines of the loaded files. */
export function moduleDigest(files: Map<string, string>): string {
  const lines = [...files.entries()]
    .filter(([p]) => isLoadedModuleFile(p))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([p, c]) => `${p} ${sha256(c)}`);
  return sha256(lines.join('\n'));
}

/** Compare the committed loaded files with the generated ones. Empty = identical. */
export function moduleIntegrityProblems(committed: Map<string, string>, expected: Map<string, string>): string[] {
  const problems: string[] = [];
  const want = [...expected.keys()].filter(isLoadedModuleFile).sort();
  const have = [...committed.keys()].filter(isLoadedModuleFile).sort();
  for (const p of want) {
    const c = committed.get(p);
    if (c === undefined) problems.push(`${p} is not in the commit`);
    else if (sha256(c) !== sha256(expected.get(p)!)) problems.push(`${p} sha256 ${sha256(c).slice(0, 12)} ≠ generated ${sha256(expected.get(p)!).slice(0, 12)}`);
  }
  for (const p of have) if (!expected.has(p)) problems.push(`${p} is in the commit but not generated`);
  return problems;
}

/** The module files of one system directory at one commit (paths relative to the directory). */
export async function readCommittedModule(domain: string, dir: string, ref: string | undefined, opts: GitStoreOptions = {}): Promise<{ commit: string; files: Map<string, string> }> {
  const prefix = `${dir.replace(/\/+$/, '')}/`;
  const read = await readFilesAt(domain, ref, [prefix], opts);
  if (read.truncated) throw new AgentModuleIntegrityError([`the module directory ${dir} is larger than one read returns`]);
  const files = new Map<string, string>();
  for (const f of read.files) if (!f.binary) files.set(f.path.slice(prefix.length), f.content);
  return { commit: read.sha, files };
}

/**
 * os-ui's `node_modules`: beside its lockfile, a KNOWN PATH (`OS_UI_LOCKFILE`; /app in the image).
 * Never a module resolution — in the bundled server `require.resolve` yields a webpack module id
 * (WP-53e), so an inline module run would have failed exactly like the generator did.
 */
export function hostNodeModules(): string {
  const dir = path.join(path.dirname(hostLockfilePath()), 'node_modules');
  if (!existsSync(path.join(dir, '@langchain', 'langgraph', 'package.json'))) {
    throw new AgentModuleIntegrityError([`os-ui's node_modules not found at ${dir} (beside OS_UI_LOCKFILE) — a module cannot import @langchain/langgraph`]);
  }
  return dir;
}

function ensureLink(cacheRoot: string): void {
  const link = path.join(cacheRoot, 'node_modules');
  if (existsSync(link)) return;
  try {
    symlinkSync(hostNodeModules(), link, 'dir');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}

const PROBLEM_SEP = '; ';

/**
 * Verify, materialise and import. A refusal (`ok: false`, reason `conflict`) is returned BEFORE
 * anything is written or imported when the committed bytes differ from the generated ones.
 */
export async function tryLoadAgentModule(input: {
  committed: Map<string, string>;
  /**
   * A NEW run: the files the generator produces from the current definition — every loaded file
   * must match them. A RESUME passes `expectedDigest` instead: the digest stamped when the run
   * started, so a parked run continues on exactly the module it began with, even after the team
   * was edited or os-ui was upgraded.
   */
  expected?: Map<string, string>;
  expectedDigest?: string;
  commit: string | null;
  cacheRoot: string;
}): Promise<Fetched<LoadedAgentModule>> {
  const at = new Date().toISOString();
  if ((input.expected === undefined) === (input.expectedDigest === undefined)) {
    return { ok: false, reason: 'invalid', detail: 'give exactly one of expected (new run) or expectedDigest (resume)', at };
  }
  const problems = input.expected
    ? moduleIntegrityProblems(input.committed, input.expected)
    : moduleDigest(input.committed) === input.expectedDigest
      ? []
      : [`the module at ${input.commit ?? 'this commit'} has digest ${moduleDigest(input.committed).slice(0, 12)}, not the stamped ${String(input.expectedDigest).slice(0, 12)}`];
  if (problems.length > 0) return { ok: false, reason: 'conflict', detail: problems.join(PROBLEM_SEP), at };
  const digest = moduleDigest(input.committed);
  mkdirSync(input.cacheRoot, { recursive: true });
  ensureLink(input.cacheRoot);
  const dir = path.join(input.cacheRoot, digest);
  if (!existsSync(path.join(dir, MODULE_GRAPH))) {
    // Write to a temp dir, then rename: a concurrent loader never imports a half-written module.
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
    for (const [p, c] of input.committed) {
      if (!isLoadedModuleFile(p)) continue;
      mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true });
      writeFileSync(path.join(tmp, p), c);
    }
    try {
      renameSync(tmp, dir);
    } catch (e) {
      if (!existsSync(path.join(dir, MODULE_GRAPH))) throw e;
    }
  }
  // Belt and braces: what is on disk is what was verified (the cache dir is content-addressed).
  if (moduleDigest(new Map([...input.committed.keys()].filter(isLoadedModuleFile).map((p) => [p, readFileSync(path.join(dir, p), 'utf8')]))) !== digest) {
    return { ok: false, reason: 'conflict', detail: `the cached copy in ${dir} does not match digest ${digest.slice(0, 12)}`, at };
  }
  const module = (await import(pathToFileURL(path.join(dir, MODULE_GRAPH)).href)) as LoadedGraphModule;
  return { ok: true, value: { module, digest, commit: input.commit, dir }, at };
}

/** {@link tryLoadAgentModule}, throwing {@link AgentModuleIntegrityError} on a refusal. */
export async function loadAgentModule(input: Parameters<typeof tryLoadAgentModule>[0]): Promise<LoadedAgentModule> {
  const r = await tryLoadAgentModule(input);
  if (!r.ok) throw new AgentModuleIntegrityError(r.detail.split(PROBLEM_SEP));
  return r.value;
}
