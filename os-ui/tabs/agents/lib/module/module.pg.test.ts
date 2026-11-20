/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-53 — the committed graph.mjs runs, parks on an approval, survives a worker restart
 *             and resumes, against the real PostgresSaver on Postgres 17
 * USER STORY: As an approver I want a held write in a team that runs from its git module to behave
 *             exactly as WP-26 made it behave: one card however often the worker restarts, the
 *             write run once as the runner when I approve, never when I reject — even if the hold
 *             policy changed while it waited — and a stale decision refused.
 * ARCHITECTURE:
 *   - Every step runs in a NEW OS process (`module.pg-fixture.ts`): new pool, saver, git read,
 *     hash check and import. Between steps only Postgres and the git repo hold state.
 *   - The model is the WP-02 harness's scripted OpenAI-compatible stub over HTTP; the script is
 *     consumed across processes, so a replay that called the model again would exhaust it (409).
 *   - Needs `AGENT_RUNS_TEST_DATABASE_URL` and `python3`. Without them the tests are SKIPPED,
 *     loudly; `REQUIRE_PG_TESTS=1` (the CI job) turns a missing database into a failure.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { commitTree, openOrInit } from '@core/infra/git-store';
import { FIXTURE_USER } from '@tabs/agents/lib/engine/parity-harness';
import { prepareFixtureTables } from '@tabs/agents/lib/engine/hitl.pg-fixture';
import { DOMAIN, SYSTEM_DIR, expectedModule, moduleStep, type ModuleStepInput } from '@tabs/agents/lib/module/fixtures/module.pg-fixture';
import { HELD_YAML } from '@tabs/agents/lib/engine/hitl.pg-fixture';
import { deleteModuleThreadRows } from '@tabs/agents/lib/module/run';
import { python3Available, startModelStub, type ModelStub } from '@tabs/agents/lib/module/fixtures/stub-model';
import { dropIsolated, isolateAgentRunsDatabase } from '@tabs/agents/lib/module/fixtures/pg-db';

// Parallel-safe: this file gets its own database (fixtures/pg-db.ts) before it reads the URL.
await isolateAgentRunsDatabase('wp53_module');
const URL_ = (process.env.AGENT_RUNS_TEST_DATABASE_URL ?? '').trim();
if (!URL_ && process.env.REQUIRE_PG_TESTS === '1') throw new Error('REQUIRE_PG_TESTS=1 but AGENT_RUNS_TEST_DATABASE_URL is not set');
if (URL_ && !python3Available() && process.env.REQUIRE_PG_TESTS === '1') throw new Error('REQUIRE_PG_TESTS=1 but python3 (the model stub) is missing');
const skip = !URL_ ? 'AGENT_RUNS_TEST_DATABASE_URL not set — the WP-53 module tests did not run' : !python3Available() ? 'python3 missing — the model stub cannot start' : false;

const OS_UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
let pool: pg.Pool;
let stub: ModelStub;
let base: Omit<ModuleStepInput, 'step' | 'runId'>;
const run = (name: string) => `wp53-${name}-${process.pid}-${Date.now()}`;

const HELD_SCRIPT = [
  { tool_calls: [{ name: 'search_knowledge', arguments: { query: 'Q3 findings' } }] },
  { tool_calls: [{ name: 'request_promotion', arguments: { kind: 'knowledge', id: 'kn_q3' } }] },
  { content: 'Filed.' },
];

async function effects(runId: string): Promise<{ tool: string; actor: string }[]> {
  const { rows } = await pool.query(`SELECT tool, actor FROM wp26_side_effects WHERE run_id = $1 ORDER BY id`, [runId]);
  return rows as { tool: string; actor: string }[];
}
async function cards(runId: string): Promise<{ interrupt_key: string; approval_id: string; approver_role: string }[]> {
  const { rows } = await pool.query(`SELECT interrupt_key, approval_id, approver_role FROM wp26_cards WHERE run_id = $1`, [runId]);
  return rows as { interrupt_key: string; approval_id: string; approver_role: string }[];
}

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 2 });
  await prepareFixtureTables(pool);
  stub = await startModelStub();
  // The module is committed to a REAL git repository; every step reads it back at this commit.
  const reposDir = mkdtempSync(path.join(os.tmpdir(), 'wp53-pg-repos-'));
  await openOrInit(DOMAIN, { reposDir });
  const tree = new Map([...expectedModule().files.entries()].map(([p, c]) => [`${SYSTEM_DIR}/${p}`, c]));
  const { sha } = await commitTree(DOMAIN, tree, { reposDir, author: { name: 'wp53', email: 'wp53@example.invalid' }, message: 'agents: wp53 module' });
  base = { reposDir, commit: sha, cacheRoot: mkdtempSync(path.join(os.tmpdir(), 'wp53-pg-cache-')), stubUrl: stub.url };
});
after(async () => {
  stub?.stop();
  await pool?.end();
  await dropIsolated();
});

test('run → approval interrupt → worker restart → resume: ONE card, the write runs once as the runner', { skip }, async () => {
  const runId = run('approve');
  await stub.script(HELD_SCRIPT);
  // 1. A worker runs the committed module: the read runs, the held write parks.
  const s1 = moduleStep({ ...base, step: 'start', runId });
  assert.equal(s1.ok, true, JSON.stringify(s1.error));
  assert.equal(s1.parked, true);
  assert.equal(s1.pendingInterruptIds?.length, 1, 'one interrupt per held call');
  const interruptId = s1.pendingInterruptIds![0];
  assert.match(interruptId, /^[0-9a-f]{16,}$/, 'a LangGraph interrupt id');
  assert.deepEqual((await effects(runId)).map((e) => e.tool), ['search_knowledge'], 'the read ran; the write did not');
  const c1 = await cards(runId);
  assert.equal(c1.length, 1);
  assert.equal(c1[0].interrupt_key, `${runId}:${interruptId}`);
  assert.equal(c1[0].approver_role, 'domain_admin');
  assert.deepEqual(s1.heldApprovals?.map((h) => [h.interruptId, h.tool, h.approvalId]), [[interruptId, 'request_promotion', c1[0].approval_id]]);

  // 2. The worker dies; a NEW one replays the parked run with no decision. Same interrupt, no
  //    second card, nothing executed, and no model call (the stub would answer the next step).
  const before = await stub.stats();
  const s2 = moduleStep({ ...base, step: 'replay', runId });
  assert.equal(s2.ok, true, JSON.stringify(s2.error));
  assert.equal(s2.parked, true);
  assert.deepEqual(s2.pendingInterruptIds, [interruptId]);
  assert.equal((await cards(runId)).length, 1, 'one card after a restart');
  assert.equal((await stub.stats()).total, before.total, 'a replay calls no model');
  assert.deepEqual((await effects(runId)).map((e) => e.tool), ['search_knowledge']);

  // 3. A third process resumes with the approval, keyed by the interrupt id.
  const s3 = moduleStep({ ...base, step: 'resume', runId, resume: { interruptId, decision: 'approve' } });
  assert.equal(s3.ok, true, JSON.stringify(s3.error));
  assert.equal(s3.reachedEnd, true);
  assert.equal(s3.finalText, 'Filed.');
  const ran = await effects(runId);
  assert.deepEqual(ran.map((e) => e.tool), ['search_knowledge', 'request_promotion'], 'each call once across three processes');
  for (const e of ran) assert.equal(e.actor, FIXTURE_USER.id, 'as the runner');

  // 4. The same decision again is refused (409) and runs nothing.
  const s4 = moduleStep({ ...base, step: 'resume', runId, resume: { interruptId, decision: 'approve' } });
  assert.equal(s4.ok, false);
  assert.equal(s4.error?.status, 409);
  assert.equal((await effects(runId)).length, 2);
});

test('negative twin: a wrong interrupt id is refused with 409; the hold policy changes while parked and a reject still never runs the write', { skip }, async () => {
  const runId = run('drift');
  await stub.script([...HELD_SCRIPT.slice(0, 2), { content: 'Understood, not filed.' }]);
  const s1 = moduleStep({ ...base, step: 'start', runId, policy: 'held' });
  assert.equal(s1.parked, true, JSON.stringify(s1.error));
  const interruptId = s1.pendingInterruptIds![0];

  const wrong = moduleStep({ ...base, step: 'resume', runId, resume: { interruptId: '0000000000000000deadbeef', decision: 'approve' } });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error?.name, 'StaleResumeError');
  assert.equal(wrong.error?.status, 409);

  // The policy flips to "not held" while the call waits: the stored decision still holds it.
  const s2 = moduleStep({ ...base, step: 'replay', runId, policy: 'not-held' });
  assert.equal(s2.parked, true, 'still held after the policy flip');
  assert.deepEqual(s2.pendingInterruptIds, [interruptId]);

  const s3 = moduleStep({ ...base, step: 'resume', runId, policy: 'not-held', resume: { interruptId, decision: 'reject' } });
  assert.equal(s3.ok, true, JSON.stringify(s3.error));
  assert.equal(s3.reachedEnd, true);
  assert.deepEqual((await effects(runId)).map((e) => e.tool), ['search_knowledge'], 'the rejected write never ran');
  assert.match(s3.toolResults?.request_promotion ?? '', /rejected_by_approver/);
});

test('negative twin: the worker dies right after an approved write — the replay never sends it again', { skip }, async () => {
  const runId = run('crash');
  await stub.script(HELD_SCRIPT);
  const s1 = moduleStep({ ...base, step: 'start', runId });
  assert.equal(s1.parked, true, JSON.stringify(s1.error));
  const interruptId = s1.pendingInterruptIds![0];
  const dead = moduleStep({ ...base, step: 'resume', runId, resume: { interruptId, decision: 'approve' }, crashAfter: 'request_promotion' });
  assert.equal(dead.exitCode, 137, 'the worker died mid-call');
  // The decision died with the worker: the replay parks on the SAME interrupt, with the same card.
  const s3 = moduleStep({ ...base, step: 'replay', runId });
  assert.equal(s3.ok, true, JSON.stringify(s3.error));
  assert.deepEqual(s3.pendingInterruptIds, [interruptId]);
  assert.equal((await cards(runId)).length, 1);
  // Approved again: the ledger knows the write was dispatched, so it is NOT sent a second time.
  const s4 = moduleStep({ ...base, step: 'resume', runId, resume: { interruptId, decision: 'approve' } });
  assert.equal(s4.ok, true, JSON.stringify(s4.error));
  assert.equal(s4.reachedEnd, true);
  assert.deepEqual((await effects(runId)).map((e) => e.tool), ['search_knowledge', 'request_promotion'], 'dispatched at most once');
  assert.match(s4.toolResults?.request_promotion ?? '', /unresolved/i, 'the agent is told the outcome is unverified');
});

test('a parked run resumes on the module stamped at its start — the team edited and the generator upgraded meanwhile', { skip }, async () => {
  const runId = run('stamped');
  await stub.script(HELD_SCRIPT);
  const s1 = moduleStep({ ...base, step: 'start', runId });
  assert.equal(s1.parked, true, JSON.stringify(s1.error));
  const interruptId = s1.pendingInterruptIds![0];

  // While it waits: the team is edited (a second agent, new prompt) and the repo HEAD moves on,
  // and the HEAD graph.mjs is what a NEWER generator emits (a changed body).
  const edited = HELD_YAML.replace("agent_md: '# writer'", "agent_md: '# writer v2'");
  const next = expectedModule(edited).files;
  next.set('graph.mjs', next.get('graph.mjs')!.replace('maxSteps = 12', 'maxSteps = 13'));
  const tree = new Map([...next.entries()].map(([p, c]) => [`${SYSTEM_DIR}/${p}`, c]));
  const { sha: head } = await commitTree(DOMAIN, tree, { reposDir: base.reposDir, author: { name: 'os', email: 'os@example.invalid' }, message: 'agents: edit + generator upgrade' });
  assert.notEqual(head, base.commit);

  // The resume reads the STAMPED commit, verified against the stamped digest — not HEAD.
  const s2 = moduleStep({ ...base, commit: head, yaml: edited, step: 'resume', runId, resume: { interruptId, decision: 'approve' } });
  assert.equal(s2.ok, true, JSON.stringify(s2.error));
  assert.equal(s2.digest, s1.digest, 'the original module, byte for byte');
  assert.equal(s2.reachedEnd, true);
  assert.deepEqual((await effects(runId)).map((e) => e.tool), ['search_knowledge', 'request_promotion']);

  // Negative twin: a NEW run against HEAD with the old definition is refused (HEAD is not what
  // this definition generates) — the check that protects new runs is still in force.
  const fresh = moduleStep({ ...base, commit: head, step: 'start', runId: run('stamped-new') });
  assert.equal(fresh.ok, false);
  assert.match(fresh.error?.message ?? '', /refusing to load graph\.mjs/);
});

test('retention removes a module run\'s stamp and hold decisions with its thread', { skip }, async () => {
  const runId = run('retention');
  await stub.script(HELD_SCRIPT);
  const s1 = moduleStep({ ...base, step: 'start', runId });
  assert.equal(s1.parked, true, JSON.stringify(s1.error));
  const count = async (t: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE thread_id = $1`, [runId])).rows[0].n);
  assert.equal(await count('agent_module_runs'), 1);
  assert.ok((await count('agent_hold_decisions')) >= 1);
  assert.ok((await deleteModuleThreadRows(pool, [runId])) >= 2);
  assert.equal(await count('agent_module_runs'), 0);
  assert.equal(await count('agent_hold_decisions'), 0);
});

test('N2: two processes booting together migrate the agent_runs database once, both succeed; the run path creates no table', { skip }, async () => {
  // A fresh database next to this file's: two fresh processes migrate it AT THE SAME TIME.
  const name = `wp53_race_${process.pid}_${Date.now()}`;
  await pool.query(`CREATE DATABASE ${name}`);
  const u = new URL(URL_);
  u.pathname = `/${name}`;
  try {
    const once = () => new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, ['--import', './scripts/test-setup.mjs', 'tabs/agents/lib/module/fixtures/migrate-once.ts', u.toString()], { cwd: OS_UI, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('exit', (code) => resolve({ code, out }));
    });
    const [a, b] = await Promise.all([once(), once()]);
    assert.equal(a.code, 0, a.out);
    assert.equal(b.code, 0, b.out);
    const ran = [a, b].map((x) => (JSON.parse(x.out.trim().split('\n').at(-1)!) as { value: string[] }).value);
    assert.deepEqual(ran.flat(), ['1763700000000_agent-module-tables'], 'exactly one process applied the migration');
    const db = new pg.Client({ connectionString: u.toString() });
    await db.connect();
    try {
      const { rows } = await db.query(`SELECT to_regclass('agent_module_runs') IS NOT NULL AS a, to_regclass('agent_hold_decisions') IS NOT NULL AS b`);
      assert.deepEqual(rows[0], { a: true, b: true });
    } finally {
      await db.end();
    }
  } finally {
    await pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
  // The run path itself: no CREATE in the module code that runs per run.
  const src = ['os-run.ts', 'run.ts', 'os-agent.ts'].map((f) => readFileSync(path.join(OS_UI, 'tabs/agents/lib/module', f), 'utf8')).join('\n');
  assert.equal(/CREATE TABLE/i.test(src), false, 'no DDL in the run path');
});

test('negative twin: a tampered graph.mjs in the commit is refused by the OS before anything runs', { skip }, async () => {
  const runId = run('tamper');
  const tree = new Map([...expectedModule().files.entries()].map(([p, c]) => [`${SYSTEM_DIR}/${p}`, c]));
  tree.set(`${SYSTEM_DIR}/graph.mjs`, tree.get(`${SYSTEM_DIR}/graph.mjs`)!.replace('maxSteps = 12', 'maxSteps = 120'));
  const { sha } = await commitTree(DOMAIN, tree, { reposDir: base.reposDir, author: { name: 'someone', email: 'someone@example.invalid' }, message: 'hand edit' });
  await stub.script(HELD_SCRIPT);
  const s = moduleStep({ ...base, commit: sha, step: 'start', runId });
  assert.equal(s.ok, false);
  assert.match(s.error?.message ?? '', /refusing to load graph\.mjs/);
  assert.deepEqual(await effects(runId), [], 'nothing ran');
  assert.equal((await stub.stats()).cursor, 0, 'no model call');
});
