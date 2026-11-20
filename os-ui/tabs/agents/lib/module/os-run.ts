/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    `runOsTeamOnModule` — a production team run on the system's committed `graph.mjs`
 * USER STORY: As a builder I want my team, once `AGENT_GRAPH_MODULE` is on, to run from the module
 *             in my domain repo — the same code an engineer gets with `node run.mjs` — under the
 *             same identity, grants, approvals and idempotency the OS applies today.
 * ARCHITECTURE:
 *   - Reads the system's directory at the repo HEAD (`readCommittedModule`), regenerates the module
 *     from the definition this run uses, and refuses on any difference (`AgentModuleIntegrityError`,
 *     no fallback to the other engine). The run records the commit and digest it loaded.
 *   - Postgres when `AGENT_RUNS_DATABASE_URL` is set (one shared pool: `PostgresSaver`, the tool-call
 *     ledger, the hold decisions, the run stamps); memory otherwise, reported as `checkpointer:
 *     'memory'` exactly like the v1 path.
 *   - Models: `ChatOpenAI` → LiteLLM with the run's scoped credential (`callerCredential`), the
 *     agent's alias or the OS tools-role model.
 *   - Not wired here yet (flag off by default; see WP-53 report): the per-node live SSE events and
 *     the per-node `runs` drill-down of the v1 result, and Langfuse node spans.
 */
import 'server-only';
import os from 'node:os';
import path from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { config } from '@core/kernel/config';
import type { CurrentUser } from '@core/kernel/auth';
import { roleModel } from '@core/models/roles';
import type { CallerContext } from '@core/infra/litellm-credential';
import { requireGatewayChatModel } from '@core/adapters/litellm/chat-model';
import type { ToolExecutor, ToolSpec } from '@core/runtime/agentic';
import type { System } from '@tabs/agents/lib/system-schema';
import { isWriteTool, type HoldDecision } from '@tabs/agents/lib/build/hold';
import type { ApprovalPort, RunnerSnapshot, RunOwner } from '@tabs/agents/lib/engine/approval-port';
import { agentRunsPool } from '@tabs/agents/lib/engine/pg-pool';
import { StaleResumeError, type ResumeDecision } from '@tabs/agents/lib/engine/run';
import { systemRepoPaths } from '@tabs/agents/lib/git/history';
import { generateAgentModule } from '@tabs/agents/lib/module/generate';
import { AgentModuleIntegrityError, loadAgentModule, readCommittedModule } from '@core/adapters/agent-module/load';
import { createOsAgent, memoryHoldStore, migrateHoldStore, postgresHoldStore, type HoldStore } from '@tabs/agents/lib/module/os-agent';
import { memoryModuleRunStamps, migrateModuleRunStamps, postgresModuleRunStamps, runAgentModule, type ModuleRunResult, type ModuleRunStamps } from '@tabs/agents/lib/module/run';
import { installedModuleVersions } from '@tabs/agents/lib/module/versions';

type Stores = { kind: 'postgres' | 'memory'; saver: unknown; holds: HoldStore; stamps: ModuleRunStamps };

const slot = globalThis as unknown as { __osModuleMemoryStores?: Stores };

/** The module run's durable stores, on the shared `agent_runs` pool (or the process memory). */
export async function moduleStores(databaseUrl: string | undefined): Promise<Stores> {
  if (!databaseUrl) {
    slot.__osModuleMemoryStores ??= { kind: 'memory', saver: new MemorySaver(), holds: memoryHoldStore(), stamps: memoryModuleRunStamps() };
    return slot.__osModuleMemoryStores;
  }
  const pool = await agentRunsPool(databaseUrl);
  await migrateHoldStore(pool);
  await migrateModuleRunStamps(pool);
  const saver = new PostgresSaver(pool);
  await saver.setup();
  return { kind: 'postgres', saver, holds: postgresHoldStore(pool), stamps: postgresModuleRunStamps(pool) };
}

/** Did this run start on its module? (A run with no stamp resumes on the v1 engine.) */
export async function isModuleRun(runId: string, databaseUrl: string | undefined): Promise<boolean> {
  return (await (await moduleStores(databaseUrl)).stamps.get(runId)) !== null;
}

export type ModuleTeamInput = {
  user: CurrentUser;
  sys: System;
  systemId: string;
  disabledAgents?: string[];
  runId: string;
  task?: string;
  resumeDecision?: ResumeDecision;
  caller: CallerContext;
  /** The `agent_runs` database (unset → memory, reported). */
  databaseUrl: string | undefined;
  specs: ToolSpec[];
  executor: ToolExecutor;
  decide: (tool: string, args: Record<string, unknown>) => HoldDecision;
  approvals: ApprovalPort;
  runner: RunnerSnapshot;
  agent: string;
  log?: (line: string) => void;
  signal?: AbortSignal;
};

export async function runOsTeamOnModule(input: ModuleTeamInput): Promise<ModuleRunResult & { checkpointer: 'postgres' | 'memory' }> {
  const domain = input.sys.system.domain;
  const dir = systemRepoPaths(domain, input.systemId)[0]?.replace(/\/$/, '');
  if (!dir) throw new AgentModuleIntegrityError([`system '${input.systemId}' has no directory in the '${domain}' repository yet`]);
  const committed = await readCommittedModule(domain, dir, undefined);
  const expected = generateAgentModule({ id: input.systemId, slug: dir.split('/').pop() ?? input.systemId, sys: input.sys, disabledAgents: input.disabledAgents, versions: installedModuleVersions() });
  const loaded = await loadAgentModule({
    committed: committed.files,
    expected: expected.files,
    commit: committed.commit,
    cacheRoot: config.agentModuleCacheDir || path.join(os.tmpdir(), 'os-agent-modules'),
  });
  const stores = await moduleStores(input.databaseUrl);
  const writeSystem = loaded.module.TOOL_NAMES.some((t) => isWriteTool(t));
  const graph = createOsAgent(loaded.module, {
    modelFor: (a) => requireGatewayChatModel({ model: a.model ?? roleModel('tools'), caller: input.caller, writeSystem }),
    specs: input.specs,
    executor: input.executor,
    decide: input.decide,
    holds: stores.holds,
    threadId: input.runId,
    checkpointer: stores.saver,
    toolCallTimeoutMs: config.agentToolCallTimeoutMs,
    toolResultMaxChars: config.agentToolResultMaxChars,
  });
  if (input.task === undefined && input.resumeDecision && !input.resumeDecision.interruptId) {
    throw new StaleResumeError(input.runId, 'stale_interrupt', 'a module run is resumed by interrupt id', true);
  }
  const owner: RunOwner = { systemId: input.systemId, userId: input.user.id, domain };
  const r = await runAgentModule({
    graph: graph as never,
    runId: input.runId,
    owner,
    ...(input.task !== undefined ? { task: input.task } : {}),
    ...(input.resumeDecision?.interruptId ? { resumeDecision: { interruptId: input.resumeDecision.interruptId, decision: input.resumeDecision.decision } } : {}),
    approvals: input.approvals,
    stamps: stores.stamps,
    runner: input.runner,
    agent: input.agent,
    module: { digest: loaded.digest, commit: loaded.commit },
    log: input.log,
    signal: input.signal,
  });
  input.log?.(`module-run runId=${input.runId} commit=${loaded.commit ?? '-'} digest=${loaded.digest.slice(0, 12)} parked=${r.parked}`);
  return { ...r, checkpointer: stores.kind };
}
