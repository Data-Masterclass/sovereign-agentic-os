/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The worker process the WP-53 Postgres tests start, stop and restart
 * USER STORY: As the engine engineer I want to prove that the COMMITTED `graph.mjs` — read from a
 *             real git commit, hash-verified, imported — runs, parks on an approval, survives a
 *             worker restart and resumes, with every step in a FRESH OS process, so nothing but
 *             Postgres and git carries state between steps.
 * ARCHITECTURE:
 *   - `node --import ./scripts/test-setup.mjs tabs/agents/lib/module/module.pg-fixture.ts '<json>'`
 *     runs ONE step (`start` | `replay` | `resume`) and prints one JSON line.
 *   - Real: git (`git-store` repo in `reposDir`), the loader's hash check, LangGraph,
 *     `createAgent`, the stock HITL middleware, `PostgresSaver`, the governed executor
 *     (`grantedToolExecutor`) and the Postgres tool-call ledger. The model is `ChatOpenAI` against
 *     the OpenAI-compatible scripted stub of the WP-02 harness (`tests/e2e/kind/model-stub/stub.py`).
 *   - Test doubles, both durable in the same Postgres (shared with the WP-26 fixture):
 *     `handleRpc` inserts one `wp26_side_effects` row per executed governed call; the Governance
 *     queue is `wp26_cards`, UNIQUE on `<thread>:<interruptId>`.
 *   - `policy: 'not-held'` makes THIS process's hold rule say "not held", so a test can change the
 *     policy between pause and resume. `crashAfter: '<tool>'` exits 137 right after that tool's
 *     side effect committed.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { CurrentUser } from '@core/kernel/auth';
import type { JsonRpcRequest, JsonRpcResponse } from '@core/mcp/server';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { grantedToolExecutor, grantedToolSpecs, type OsToolDeps } from '@tabs/agents/lib/build/os-tools';
import { holdDecisionFor } from '@tabs/agents/lib/build/hold';
import { migrateToolCallLedger, postgresToolCallLedger, withToolCallLedger } from '@tabs/agents/lib/engine/tool-call-ledger';
import { FIXTURE_USER } from '@tabs/agents/lib/engine/parity-harness';
import { HELD_YAML, pgApprovalPort, prepareFixtureTables } from '@tabs/agents/lib/engine/hitl.pg-fixture';
import { generateAgentModule } from '@tabs/agents/lib/module/generate';
import { hostModuleInputs } from '@tabs/agents/lib/module/versions';
import { createOsAgent, postgresHoldStore } from '@tabs/agents/lib/module/os-agent';
import { migrateAgentRuns } from '@core/adapters/postgres/migrate';
import { requireGatewayChatModel } from '@core/adapters/litellm/chat-model';
import { postgresModuleRunStamps, runAgentModule } from '@tabs/agents/lib/module/run';
import { loadModuleForRun } from '@tabs/agents/lib/module/os-run';
import type { ApprovalDecision } from '@tabs/agents/lib/engine/approval-port';

export const SYSTEM_ID = 'sys-wp53';
export const SYSTEM_DIR = 'agents/wp53';
export const DOMAIN = 'sales';
const OS_UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');


/** The module the OS generates for the fixture system (HELD_YAML: one writer, a held write). */
export function expectedModule(yaml = HELD_YAML) {
  return generateAgentModule({ id: SYSTEM_ID, slug: 'wp53', sys: parseSystem(yaml), ...hostModuleInputs() });
}

export type ModuleStepInput = {
  step: 'start' | 'replay' | 'resume';
  runId: string;
  reposDir: string;
  commit: string;
  cacheRoot: string;
  stubUrl: string;
  policy?: 'held' | 'not-held';
  resume?: { interruptId: string; decision: ApprovalDecision };
  crashAfter?: string;
  /** The definition THIS process holds (default HELD_YAML) — a test edits it while a run is parked. */
  yaml?: string;
};

export type ModuleStepOutput = {
  ok: boolean;
  error?: { name: string; message: string; status?: number; code?: string };
  parked?: boolean;
  reachedEnd?: boolean;
  heldApprovals?: { approvalId: string; interruptId: string; tool: string }[];
  pendingInterruptIds?: string[];
  toolResults?: Record<string, string>;
  finalText?: string;
  digest?: string;
};

export async function runModuleStep(input: ModuleStepInput): Promise<ModuleStepOutput> {
  const url = (process.env.AGENT_RUNS_TEST_DATABASE_URL ?? '').trim();
  if (!url) throw new Error('AGENT_RUNS_TEST_DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  try {
    const saver = new PostgresSaver(pool);
    await saver.setup();
    await prepareFixtureTables(pool);
    await migrateToolCallLedger(pool);
    // What a booting worker does (worker/agent-runs.ts): the agent_runs migrations, once, under
    // node-pg-migrate's advisory lock — the run path itself creates nothing.
    const mig = await migrateAgentRuns({ databaseUrl: url });
    if (!mig.ok) throw new Error(`migrateAgentRuns: ${mig.reason} ${mig.detail}`);
    const sys = parseSystem(HELD_YAML);
    // What runs is what is in git. A new run: the module at `commit`, verified against what the
    // generator produces from the definition. A resume: the commit stamped at the run's start.
    const stamps = postgresModuleRunStamps(pool);
    const loaded = await loadModuleForRun({
      domain: DOMAIN,
      dir: SYSTEM_DIR,
      stamp: input.step === 'start' ? null : await stamps.get(input.runId),
      ref: input.commit,
      expected: () => expectedModule(input.yaml ?? HELD_YAML).files,
      cacheRoot: input.cacheRoot,
      reposDir: input.reposDir,
    });
    const spy: OsToolDeps = {
      enqueue: (() => { throw new Error('the executor must not hold under holdAt:node'); }) as unknown as OsToolDeps['enqueue'],
      handleRpc: (async (user: CurrentUser, req: JsonRpcRequest): Promise<JsonRpcResponse> => {
        const tool = String(req.params?.name ?? '');
        await pool.query(`INSERT INTO wp26_side_effects (run_id, tool, actor, pid) VALUES ($1,$2,$3,$4)`, [input.runId, tool, user.id, process.pid]);
        if (input.crashAfter === tool) process.exit(137);
        return { jsonrpc: '2.0', id: req.id ?? 1, result: { content: [{ type: 'text', text: JSON.stringify({ ran: tool }) }] } };
      }) as unknown as OsToolDeps['handleRpc'],
      trace: (async () => undefined) as unknown as OsToolDeps['trace'],
    };
    const executor = withToolCallLedger(grantedToolExecutor(FIXTURE_USER, sys, SYSTEM_ID, spy, { holdAt: 'node' }), postgresToolCallLedger(pool));
    const policy = input.policy ?? 'held';
    const graph = createOsAgent(loaded.module, {
      modelFor: () => requireGatewayChatModel({ model: 'stub', baseURL: input.stubUrl, apiKey: 'sk-stub', writeSystem: true }),
      specs: grantedToolSpecs(FIXTURE_USER, sys),
      executor,
      decide: (tool) => (policy === 'held' ? holdDecisionFor(sys.safetyPreset, tool) : { held: false }),
      holds: postgresHoldStore(pool),
      threadId: input.runId,
      checkpointer: saver,
    });
    try {
      const r = await runAgentModule({
        graph: graph as never,
        runId: input.runId,
        owner: { systemId: SYSTEM_ID, userId: FIXTURE_USER.id, domain: DOMAIN },
        ...(input.step === 'start' ? { task: 'File the promotion of the Q3 findings.' } : {}),
        ...(input.resume ? { resumeDecision: input.resume } : {}),
        approvals: pgApprovalPort(pool),
        stamps,
        runner: { id: FIXTURE_USER.id, role: FIXTURE_USER.role, domains: FIXTURE_USER.domains },
        agent: `os-${SYSTEM_ID}`,
        module: { digest: loaded.digest, commit: loaded.commit },
      });
      const messages = (r.values.messages ?? []) as { type?: string; name?: string; content?: unknown }[];
      const toolResults: Record<string, string> = {};
      for (const m of messages) if (m.type === 'tool' && m.name) toolResults[m.name] = String(m.content);
      const snap = await graph.getState({ configurable: { thread_id: input.runId } });
      const pendingInterruptIds = snap.tasks.flatMap((t) => t.interrupts.map((i) => String(i.id)));
      return {
        ok: true,
        parked: r.parked,
        reachedEnd: r.reachedEnd,
        heldApprovals: r.heldApprovals,
        pendingInterruptIds,
        toolResults,
        finalText: r.finalText,
        digest: loaded.digest,
      };
    } catch (e) {
      const err = e as Error & { status?: number; code?: string };
      return { ok: false, error: { name: err.name, message: err.message, status: err.status, code: err.code } };
    }
  } finally {
    await pool.end();
  }
}

const FIXTURE = 'tabs/agents/lib/module/fixtures/module.pg-fixture.ts';

/** One step in a FRESH node process. */
export function moduleStep(input: ModuleStepInput): ModuleStepOutput & { exitCode: number | null } {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './scripts/test-setup.mjs', FIXTURE, JSON.stringify(input)], {
    cwd: OS_UI,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const line = (r.stdout ?? '').trim().split('\n').filter(Boolean).at(-1);
  if (!line) return { ok: false, exitCode: r.status, error: { name: 'NoOutput', message: (r.stderr ?? '').slice(-2000) } };
  return { ...(JSON.parse(line) as ModuleStepOutput), exitCode: r.status };
}

if (process.argv[1] && process.argv[1].endsWith('module.pg-fixture.ts')) {
  const input = JSON.parse(process.argv[2] ?? '{}') as ModuleStepInput;
  runModuleStep(input)
    .then((out) => {
      process.stdout.write(`${JSON.stringify(out)}\n`);
      process.exit(0);
    })
    .catch((e) => {
      process.stdout.write(`${JSON.stringify({ ok: false, error: { name: 'FixtureError', message: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) } })}\n`);
      process.exit(1);
    });
}
