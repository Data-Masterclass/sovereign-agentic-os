/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The worker process the HITL / durability Postgres tests start, stop and restart
 * USER STORY: As the engine engineer I want to prove pause → worker restart → resume against the
 *             REAL LangGraph library and the REAL PostgresSaver, so every step of a test runs in a
 *             FRESH OS process: a new `pg.Pool`, a new `PostgresSaver`, a newly compiled graph.
 *             Nothing survives between steps except what Postgres holds.
 * ARCHITECTURE:
 *   - `node --import ./scripts/test-setup.mjs tabs/agents/lib/engine/hitl.pg-fixture.ts '<json>'`
 *     runs ONE step (`start` | `replay` | `resume`) of one run and prints one JSON line.
 *   - The graph is the production `buildGraph` (via `runGraphEngine`) with the REAL governed
 *     executor (`grantedToolExecutor`, `holdAt:'node'`). Only two things are test doubles, and
 *     both are durable in the same Postgres so a restart cannot hide a duplicate:
 *       · the model: STATELESS — it answers the batch until a tool result is in the transcript,
 *         then FINAL (a counter would reset in a fresh process and replay the batch);
 *       · `handleRpc`: every executed governed call INSERTs one row into `wp26_side_effects`
 *         (who ran it, which tool) — the side effect whose exactly-once the tests assert;
 *       · the Governance queue: `wp26_cards`, UNIQUE on `interrupt_key`, the same idempotency
 *         contract as `core/policy/approvals.ts` `enqueueOnce`.
 *   - `crashOn: '<tool>'` kills this process (exit 137) the moment that tool is dispatched — a
 *     real worker death mid-superstep, not a thrown error.
 *   - `policy: 'held' | 'not-held'` is the hold rule THIS process uses, so a test can change the
 *     policy between pause and resume.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { CurrentUser } from '@core/kernel/auth';
import type { JsonRpcRequest, JsonRpcResponse } from '@core/mcp/server';
import type { LlmCall } from '@core/runtime/agentic';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import { grantedToolExecutor, grantedToolSpecs, type OsToolDeps } from '@tabs/agents/lib/build/os-tools';
import { holdDecisionFor } from '@tabs/agents/lib/build/hold';
import type { ApprovalDecision, ApprovalPort, ApprovalState } from '@tabs/agents/lib/engine/approval-port';
import type { GraphDeps } from '@tabs/agents/lib/engine/build-graph';
import { runGraphEngine, type ResumeDecision } from '@tabs/agents/lib/engine/run';
import { FIXTURE_USER } from '@tabs/agents/lib/engine/parity-harness';

export const SYSTEM_ID = 'sys-wp26';
export const OWNER = { systemId: SYSTEM_ID, userId: FIXTURE_USER.id, domain: 'sales' };

/** One agent; a read and an escalating write (held for a domain_admin under read-propose). */
export const HELD_YAML = `version: '1'
system: { name: wp26, domain: sales, visibility: Personal }
safety_preset: read-propose
entrypoint: writer
grants: { data: [], knowledge: [], metrics: [], tools: [search_knowledge, request_promotion, query_data], connections: [] }
agents:
  - { id: writer, role: writes, agent_md: '# writer', memory_md: '# Memory', tools: [search_knowledge, request_promotion, query_data] }
edges: []
`;

export type Call = { id: string; name: string; args: Record<string, unknown> };

export const HELD_BATCH: Call[] = [
  { id: 'c-read', name: 'search_knowledge', args: { query: 'Q3 findings' } },
  { id: 'c-write', name: 'request_promotion', args: { kind: 'knowledge', id: 'kn_q3' } },
];

export const READ_BATCH: Call[] = [
  { id: 'c-1', name: 'search_knowledge', args: { query: 'a' } },
  { id: 'c-2', name: 'query_data', args: { sql: 'select 1' } },
];

export type StepInput = {
  step: 'start' | 'replay' | 'resume';
  runId: string;
  batch: 'held' | 'reads';
  policy?: 'held' | 'not-held';
  resume?: ResumeDecision;
  crashOn?: string;
};

export type StepOutput = {
  ok: boolean;
  error?: { name: string; message: string; status?: number; code?: string };
  parked?: boolean;
  reachedEnd?: boolean;
  heldApprovals?: { approvalId: string; interruptId: string; tool: string; node: string }[];
  /** The interrupts LangGraph holds for the thread (`getState().tasks[].interrupts`). */
  pendingInterruptIds?: string[];
  /** Typed tool results the model saw, per call id. */
  toolResults?: Record<string, string>;
};

export function testDatabaseUrl(): string {
  return (process.env.AGENT_RUNS_TEST_DATABASE_URL ?? '').trim();
}

/** The two durable test doubles' tables. Idempotent. */
export async function prepareFixtureTables(pool: pg.Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS wp26_side_effects (
    id BIGSERIAL PRIMARY KEY, run_id TEXT NOT NULL, tool TEXT NOT NULL, actor TEXT NOT NULL, pid INT NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS wp26_cards (
    approval_id TEXT PRIMARY KEY, interrupt_key TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL,
    tool TEXT NOT NULL, node TEXT NOT NULL, approver_role TEXT NOT NULL, status TEXT NOT NULL)`);
}

/** A Postgres-backed ApprovalPort with `enqueueOnce`'s contract: one card per `interruptKey`. */
export function pgApprovalPort(pool: pg.Pool): ApprovalPort {
  return {
    async enqueueOnce(input) {
      const id = `apr_${input.interruptKey.replace(/[^a-zA-Z0-9]/g, '').slice(-24)}`;
      await pool.query(
        `INSERT INTO wp26_cards (approval_id, interrupt_key, run_id, tool, node, approver_role, status)
         VALUES ($1,$2,$3,$4,$5,$6,'pending') ON CONFLICT (interrupt_key) DO NOTHING`,
        [id, input.interruptKey, input.runId, input.tool, input.node, input.approverRole],
      );
      const { rows } = await pool.query(`SELECT approval_id, status FROM wp26_cards WHERE interrupt_key = $1`, [input.interruptKey]);
      return { approvalId: rows[0].approval_id as string, status: rows[0].status as ApprovalState };
    },
    async status(approvalId) {
      const { rows } = await pool.query(`SELECT status FROM wp26_cards WHERE approval_id = $1`, [approvalId]);
      return (rows[0]?.status as ApprovalState | undefined) ?? 'unknown';
    },
    async find(interruptKey) {
      const { rows } = await pool.query(`SELECT approval_id, status FROM wp26_cards WHERE interrupt_key = $1`, [interruptKey]);
      return rows[0] ? { approvalId: rows[0].approval_id as string, status: rows[0].status as ApprovalState } : null;
    },
  };
}

/** Stateless scripted model: the batch until a tool result is in the transcript, then FINAL. */
function statelessModel(batch: Call[]): LlmCall {
  return async (req) => {
    if (!req.tools) return { content: 'plan: do it', toolCalls: [] };
    if (req.messages.some((m) => m.role === 'tool')) return { content: 'FINAL(writer)', toolCalls: [] };
    return { content: '', toolCalls: batch };
  };
}

export async function runStep(input: StepInput): Promise<StepOutput> {
  const url = testDatabaseUrl();
  if (!url) throw new Error('AGENT_RUNS_TEST_DATABASE_URL is not set');
  // A FRESH pool, saver and graph — this process knows nothing but what Postgres holds.
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  try {
    const saver = new PostgresSaver(pool);
    await saver.setup();
    await prepareFixtureTables(pool);
    const sys = parseSystem(HELD_YAML);
    const ir = compile(sys);
    const spy: OsToolDeps = {
      enqueue: (() => { throw new Error('the executor must not hold under holdAt:node'); }) as unknown as OsToolDeps['enqueue'],
      handleRpc: (async (user: CurrentUser, req: JsonRpcRequest): Promise<JsonRpcResponse> => {
        const tool = String(req.params?.name ?? '');
        if (input.crashOn === tool) process.exit(137); // a real worker death mid-superstep
        await pool.query(`INSERT INTO wp26_side_effects (run_id, tool, actor, pid) VALUES ($1,$2,$3,$4)`, [input.runId, tool, user.id, process.pid]);
        return { jsonrpc: '2.0', id: req.id ?? 1, result: { content: [{ type: 'text', text: JSON.stringify({ ran: tool }) }] } };
      }) as unknown as OsToolDeps['handleRpc'],
      trace: (async () => undefined) as unknown as OsToolDeps['trace'],
    };
    const policy = input.policy ?? 'held';
    const toolResults: Record<string, string> = {};
    const deps: Omit<GraphDeps, 'checkpointer'> = {
      llm: statelessModel(input.batch === 'held' ? HELD_BATCH : READ_BATCH),
      toolSpecsFor: (node) => grantedToolSpecs(FIXTURE_USER, sys, node.tools),
      callTool: grantedToolExecutor(FIXTURE_USER, sys, SYSTEM_ID, spy, { holdAt: 'node' }),
      preamble: 'RULES',
      reasoningModel: 'reasoning',
      execModel: 'fast',
      maxIterations: 4,
      maxRunSteps: 20,
      hold: {
        decide: (tool) => (policy === 'held' ? holdDecisionFor(sys.safetyPreset, tool) : { held: false }),
        approvals: pgApprovalPort(pool),
        systemId: SYSTEM_ID,
        domain: 'sales',
        runner: { id: FIXTURE_USER.id, role: FIXTURE_USER.role, domains: FIXTURE_USER.domains },
        agent: `os-${SYSTEM_ID}`,
      },
    };
    try {
      const r = await runGraphEngine({
        ir,
        deps,
        messages: [{ role: 'user', content: 'File the promotion of the Q3 findings.' }],
        runId: input.runId,
        owner: OWNER,
        checkpointer: { kind: 'postgres', saver },
        ...(input.step === 'start' ? {} : { resume: true }),
        ...(input.resume ? { resumeDecision: input.resume } : {}),
        hooks: { onStep: (ev) => { toolResults[ev.step.tool] = ev.step.result; } },
      });
      const snap = await saver.getTuple({ configurable: { thread_id: input.runId } });
      const pendingInterruptIds = (snap?.pendingWrites ?? [])
        .filter(([, channel]) => channel === '__interrupt__')
        .flatMap(([, , value]) => (Array.isArray(value) ? value : [value]))
        .map((v) => String((v as { id?: string }).id ?? ''));
      return { ok: true, parked: r.parked, reachedEnd: r.reachedEnd, heldApprovals: r.heldApprovals, pendingInterruptIds, toolResults };
    } catch (e) {
      const err = e as Error & { status?: number; code?: string };
      return { ok: false, error: { name: err.name, message: err.message, status: err.status, code: err.code } };
    }
  } finally {
    await pool.end();
  }
}


const OS_UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURE = 'tabs/agents/lib/engine/hitl.pg-fixture.ts';

/** Run one step of a run in a FRESH node process; returns its JSON line and exit status. */
export function step(input: StepInput): StepOutput & { exitCode: number | null } {
  const r = spawnSync(process.execPath, ['--import', './scripts/test-setup.mjs', FIXTURE, JSON.stringify(input)], {
    cwd: OS_UI,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const line = (r.stdout ?? '').trim().split('\n').filter(Boolean).at(-1);
  if (!line) return { ok: false, exitCode: r.status, error: { name: 'NoOutput', message: (r.stderr ?? '').slice(-2000) } };
  return { ...(JSON.parse(line) as StepOutput), exitCode: r.status };
}

/** Decision type re-exported for the tests' payloads. */
export type { ApprovalDecision };

if (process.argv[1] && process.argv[1].endsWith('hitl.pg-fixture.ts')) {
  const input = JSON.parse(process.argv[2] ?? '{}') as StepInput;
  runStep(input)
    .then((out) => {
      process.stdout.write(`${JSON.stringify(out)}\n`);
      process.exit(0);
    })
    .catch((e) => {
      process.stdout.write(`${JSON.stringify({ ok: false, error: { name: 'FixtureError', message: e instanceof Error ? e.message : String(e) } })}\n`);
      process.exit(1);
    });
}
