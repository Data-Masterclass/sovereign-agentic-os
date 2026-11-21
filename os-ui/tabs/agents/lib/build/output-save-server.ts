/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The governed door the engine saves a run's declared outputs through
 * USER STORY: As the owner of a system I want what the engine files for me after a run to be
 *             written exactly as if I had done it by hand in Files, Knowledge and Data: as me,
 *             under my role, in the folder I declared and nowhere else, and visible in the same
 *             audit trail as every other tool call of the run.
 * ARCHITECTURE:
 *   - NOT A NEW DOOR. `outputDispatchFor` returns the agent gate's own `callTool`
 *     (`agentToolGate`, `os-tools.ts`): tool-name gate → resource grants (`grant-scope.ts`) →
 *     `handleRpc` AS THE RUNNING USER → governance trace under the run. A tab reaches another
 *     tab only this way; nothing here imports the Files, Knowledge or Data stores.
 *   - A NARROWER SCOPE THAN THE AGENTS'. The gate is built on `outputSaveSystem(run system)`: the
 *     saver's tools and the declared folders only. Its Data and Knowledge folder grants are
 *     resolved to the items they hold now, from the runner's own listing — the same late binding
 *     a run's grants get — so the dataset of an earlier run is found and versioned.
 *   - THE HOLD is decided by the saver itself (`output-saver.ts`, with `holdDecisionFor`), before
 *     it dispatches: the gate is built with `holdAt: 'node'`, the mode in which the caller has
 *     already made that decision. It is the arrangement the engine's tools node uses.
 *   - `saveRunOutputs` is the one entry both callers use: the end of a run (`run-service.ts`)
 *     and the person's own "Save now" (`app/api/agents/systems/[id]/outputs/save`).
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { agentToolGate, resolveFolderGrants, serverScopedItemsLoader, type OsToolDeps, type ScopedItemsLoader } from '@tabs/agents/lib/build/os-tools';
import { outputSaveSystem, saveDeclaredOutputs, type OutputDispatch, type OutputResult, type SaveOutputsInput } from '@tabs/agents/lib/output-saver';
import type { System } from '@tabs/agents/lib/system-schema';

export type OutputDoorOptions = {
  /** Injected in tests: the governed executor deps (handleRpc / trace / resolvers). */
  toolDeps?: OsToolDeps;
  /** Injected in tests: the runner's scoped listings the folder grants resolve against. */
  load?: ScopedItemsLoader;
};

/** The door for one save: every call is checked against the declared folders and runs as `user`. */
export async function outputDispatchFor(
  user: CurrentUser,
  runSystem: System,
  systemId: string,
  runId: string,
  opts: OutputDoorOptions = {},
): Promise<OutputDispatch> {
  const narrowed = outputSaveSystem(runSystem);
  const { system } = await resolveFolderGrants(narrowed, opts.load ?? serverScopedItemsLoader(user));
  const gate = agentToolGate(user, system, systemId, opts.toolDeps, { holdAt: 'node', traceContext: { traceId: runId } });
  return (tool, args) => gate.callTool(tool, args);
}

export type SaveRunOutputsInput = Omit<SaveOutputsInput, 'dispatch' | 'runnerId'> & { user: CurrentUser } & OutputDoorOptions;

/**
 * Save a run's declared outputs as the running user. Never throws: when even the door cannot be
 * built, every output is reported as failed with that reason and can be tried again.
 */
export async function saveRunOutputs(input: SaveRunOutputsInput): Promise<OutputResult[]> {
  const { user, toolDeps, load, ...rest } = input;
  if ((rest.system.outputs ?? []).length === 0) return [];
  let dispatch: OutputDispatch;
  try {
    dispatch = await outputDispatchFor(user, rest.system, rest.systemId, rest.runId, { toolDeps, load });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    dispatch = async () => ({ text: JSON.stringify({ error: { code: 'upstream_error', reason: `the save could not start (${why})` } }), isError: true });
  }
  return saveDeclaredOutputs({ ...rest, runnerId: user.id, runnerDomains: user.domains, dispatch });
}
