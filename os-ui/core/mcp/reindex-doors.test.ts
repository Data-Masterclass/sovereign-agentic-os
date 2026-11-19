/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The two re-index doors — the MCP tool and the HTTP route — gated and consistent
 * USER STORY: As a platform admin I need both doors to re-index the same way: admin-only, one
 *             running job per target, a typed refusal when an engine is down, and the honesty
 *             caveat in the payload rather than only in the UI.
 * ARCHITECTURE:
 *   - The tool is built by a factory over injected services, so this suite drives it with fakes:
 *     no OpenSearch, no gateway, no tab store.
 *   - The ROUTE is a `route.ts` a test may not import (it pulls `next/headers`), so its gate is
 *     asserted over its SOURCE — the pattern `core/security-route-guards.test.ts` established —
 *     and its behaviour is the services', which their own suites cover.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { reindexTools, jobPayload, planPayload, type ReindexServices } from '@core/mcp/reindex-tools';
import { roleCanUse } from '@core/mcp/server';
import {
  UNMARKED_CAVEAT,
  startOrResume,
  __resetReindexJobs,
  type ReindexJob,
  type ReindexPlan,
  type ReindexTarget,
} from '@core/kernel/reindex';
import type { CurrentUser } from '@core/kernel/auth';

const OSUI = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(resolve(OSUI, p), 'utf8');

const admin = { id: 'u_admin', domains: ['sales'], role: 'admin' } as unknown as CurrentUser;
const builder = { id: 'u_b', domains: ['sales'], role: 'builder' } as unknown as CurrentUser;

function plan(over: Partial<ReindexPlan> = {}): ReindexPlan {
  return {
    target: 'files',
    filter: 'marked',
    counts: { marked: 3, 'missing-representation': 0, 'missing-vector': 1, 'dimension-mismatch': 0, all: 20 },
    units: [{ id: 'f1', label: 'a.pdf', reasons: ['marked'], rows: 3 }],
    rowsTotal: 20,
    mappingDim: 384,
    configuredDim: 384,
    engines: [{ name: 'Docling (document parser)', url: 'http://docling:5001/health', ready: true, detail: null }],
    ready: true,
    blockedReason: null,
    unmarkedCaveat: UNMARKED_CAVEAT,
    truncated: false,
    ...over,
  };
}

function job(over: Partial<ReindexJob> = {}): ReindexJob {
  return {
    id: 'rix_files_1', target: 'files', filter: 'marked', status: 'running',
    total: 3, cursor: 1, replaced: 1, failed: 0, skipped: 0,
    startedAt: 'a', updatedAt: 'b', finishedAt: null, by: 'u_admin', failures: [], error: null,
    ...over,
  };
}

function services(over: {
  plan?: ReindexPlan;
  run?: { started: boolean; job: ReindexJob; reason?: string };
  onPlan?: (target: ReindexTarget) => void;
  onRun?: (target: ReindexTarget) => void;
  onRunPlan?: (plan: ReindexPlan | null) => void;
  onAbandon?: (target: ReindexTarget) => void;
  abandon?: { abandoned: boolean; job: ReindexJob | null; reason?: string };
  inFlight?: boolean;
  throwOnRun?: unknown;
  assertAdmin?: boolean;
} = {}): ReindexServices {
  const make = (target: ReindexTarget) => ({
    planReindex: async (principal: { role: string }) => {
      if (over.assertAdmin !== false && principal.role !== 'admin') {
        throw Object.assign(new Error('Re-indexing a corpus is admin-only'), { status: 403 });
      }
      over.onPlan?.(target);
      return over.plan ?? plan({ target });
    },
    runReindex: async (principal: { role: string }, planArg: ReindexPlan | null) => {
      if (over.assertAdmin !== false && principal.role !== 'admin') {
        throw Object.assign(new Error('Re-indexing a corpus is admin-only'), { status: 403 });
      }
      over.onRun?.(target);
      over.onRunPlan?.(planArg);
      if (over.throwOnRun) throw over.throwOnRun;
      return over.run ?? { started: true, job: job({ target, status: 'running' }) };
    },
    abandonReindex: async (principal: { role: string }) => {
      if (over.assertAdmin !== false && principal.role !== 'admin') {
        throw Object.assign(new Error('Re-indexing a corpus is admin-only'), { status: 403 });
      }
      over.onAbandon?.(target);
      return over.abandon ?? { abandoned: true, job: job({ target, status: 'failed', error: 'Abandoned by u_admin at 1/3.' }) };
    },
    inFlight: () => Boolean(over.inFlight),
  });
  return { files: make('files'), knowledge: make('knowledge') };
}

const tool = (svc: ReindexServices = services()) => reindexTools(svc)[0];

// ---------------------------------------------------------------------------
//  The MCP door
// ---------------------------------------------------------------------------

test('MCP: reindex_corpus is admin-only, and no lower role may even see it', () => {
  const t = tool();
  assert.equal(t.name, 'reindex_corpus');
  assert.equal(t.minRole, 'admin');
  assert.equal(roleCanUse('admin', t.minRole), true);
  for (const role of ['creator', 'builder', 'domain_admin'] as const) {
    assert.equal(roleCanUse(role, t.minRole), false, `${role} must not see reindex_corpus`);
  }
});

test('MCP: one tool, both corpora — `tab` plus `extraTabs`, the promotion-tool mechanism', () => {
  const t = tool();
  assert.equal(t.tab, 'files');
  assert.deepEqual(t.extraTabs, ['knowledge']);
});

test('MCP: the description states the blind spot, not just the feature', () => {
  const d = tool().description;
  assert.match(d, /ADMIN ONLY/);
  assert.match(d, /DRY RUN/);
  assert.match(d, /indistinguishable from a real one/);
  assert.match(d, /already-running/);
  assert.match(d, /ENGINE_UNAVAILABLE/);
  assert.match(d, /NOTHING is read, replaced or deleted/);
});

test('MCP: the argument shape is the route’s shape — same target, mode and filter vocabulary', () => {
  const schema = tool().inputSchema as {
    properties: Record<string, { enum?: string[] }>;
    required: string[];
  };
  assert.deepEqual(schema.properties.target.enum, ['files', 'knowledge']);
  assert.deepEqual(schema.properties.mode.enum, ['plan', 'run', 'abandon']);
  assert.deepEqual(schema.properties.filter.enum, ['marked', 'all']);
  assert.deepEqual(schema.required, ['target']);
});

test('MCP: the governed service re-gates — a builder calling it is refused 403 in-lib', async () => {
  await assert.rejects(
    () => tool().call(builder, { target: 'files', mode: 'plan' }),
    (e: Error & { status?: number }) => e.status === 403 && /admin-only/.test(e.message),
  );
});

test('MCP: plan is a dry run and carries the counts AND the caveat', async () => {
  let ran = false;
  const out = (await tool(services({ onRun: () => { ran = true; } })).call(admin, {
    target: 'files', mode: 'plan', filter: 'marked',
  })) as Record<string, unknown>;
  assert.equal(ran, false, 'a plan never runs anything');
  assert.deepEqual(out.counts, plan().counts);
  assert.equal(out.caveat, UNMARKED_CAVEAT);
  assert.equal(out.ready, true);
  assert.equal(out.unitsSelected, 1);
});

test('MCP: the default mode is plan and the default filter is marked — the safe pair', async () => {
  const out = (await tool().call(admin, { target: 'knowledge' })) as Record<string, unknown>;
  assert.equal(out.filter, 'marked');
  assert.equal(out.target, 'knowledge');
  assert.ok('counts' in out, 'it answered with a plan, not a run');
});

test('MCP: run reports the job the way the other long tools do', async () => {
  const out = (await tool().call(admin, { target: 'files', mode: 'run', filter: 'all' })) as {
    started: boolean; job: Record<string, unknown>; caveat: string;
  };
  assert.equal(out.started, true);
  assert.equal(out.job.status, 'running');
  assert.equal(out.job.total, 3);
  assert.equal(out.job.done, 1);
  assert.equal(out.job.remaining, 2);
  assert.equal(out.caveat, UNMARKED_CAVEAT);
});

test('MCP: a run already in flight reports progress — never a twin, never a phantom success', async () => {
  const out = (await tool(
    services({ run: { started: false, job: job({ cursor: 2 }), reason: 'already-running' } }),
  ).call(admin, { target: 'files', mode: 'run' })) as { started: boolean; reason: string; job: { done: number } };
  assert.equal(out.started, false);
  assert.equal(out.reason, 'already-running');
  assert.equal(out.job.done, 2);
});

test('MCP: a blocked plan is a 503 naming the component, not a quiet no-op', async () => {
  await assert.rejects(
    () =>
      tool(services({ plan: plan({ ready: false, blockedReason: 'Docling (document parser) is not reachable at http://docling:5001/health — HTTP 502.' }) }))
        .call(admin, { target: 'files', mode: 'run' }),
    (e: Error & { status?: number }) => e.status === 503 && /Docling/.test(e.message),
  );
});

test('MCP: nothing selected is said plainly, with the plan, and starts no job', async () => {
  let ran = false;
  const out = (await tool(services({ plan: plan({ units: [] }), onRun: () => { ran = true; } })).call(admin, {
    target: 'files', mode: 'run',
  })) as { started: boolean; reason: string; job: unknown };
  assert.equal(out.started, false);
  assert.equal(out.reason, 'nothing-selected');
  assert.equal(out.job, null);
  assert.equal(ran, false);
});

test('MCP: the typed refusal is NOT caught here — structuredError is the one mapping door', async () => {
  const refusal = Object.assign(new Error('the gateway went away'), { status: 503, code: 'ENGINE_UNAVAILABLE' });
  await assert.rejects(
    () => tool(services({ throwOnRun: refusal })).call(admin, { target: 'files', mode: 'run' }),
    (e: Error & { code?: string }) => e.code === 'ENGINE_UNAVAILABLE',
  );
});

test('MCP: status:true is a pure read — no plan, no probe, no write', async () => {
  let planned = false;
  const out = (await tool(services({ onPlan: () => { planned = true; } })).call(admin, {
    target: 'knowledge', status: true,
  })) as { target: string; job: unknown; running: boolean };
  assert.equal(planned, false);
  assert.equal(out.target, 'knowledge');
  assert.equal(out.running, false, 'nothing is running in a fresh process');
});

test('MCP: a bad target or filter is the caller’s fault — 400, naming what it got', async () => {
  await assert.rejects(
    () => tool().call(admin, { target: 'metrics', mode: 'plan' }),
    (e: Error & { status?: number }) => e.status === 400 && /got "metrics"/.test(e.message),
  );
  await assert.rejects(
    () => tool().call(admin, { target: 'files', mode: 'plan', filter: 'MARKED' }),
    (e: Error & { status?: number }) => e.status === 400 && /got "MARKED"/.test(e.message),
  );
  await assert.rejects(
    () => tool().call(admin, { target: 'files', mode: 'wipe' }),
    (e: Error & { status?: number }) => e.status === 400 && /got "wipe"/.test(e.message),
  );
});

test('MCP: a target whose tab is not registered is a stated 409, not a crash', async () => {
  const onlyFiles = { files: services().files } as unknown as ReindexServices;
  await assert.rejects(
    () => reindexTools(onlyFiles)[0].call(admin, { target: 'knowledge', mode: 'plan' }),
    (e: Error & { status?: number }) => e.status === 409 && /not enabled/.test(e.message),
  );
});

test('MCP: the payload helpers expose progress without leaking internals', () => {
  const p = planPayload(plan({ units: Array.from({ length: 50 }, (_, i) => ({ id: `f${i}`, label: `f${i}`, reasons: ['all'], rows: 1 })) }));
  assert.equal((p.sample as unknown[]).length, 20, 'a sample, not the whole list');
  assert.equal(p.unitsSelected, 50, 'but the real count');
  const j = jobPayload(job());
  assert.deepEqual(Object.keys(j).sort(), [
    'by', 'error', 'failed', 'failures', 'filter', 'finishedAt', 'id', 'remaining', 'replaced',
    'skipped', 'startedAt', 'status', 'target', 'done', 'total',
  ].sort());
});

// ---------------------------------------------------------------------------
//  The HTTP door
// ---------------------------------------------------------------------------

const ROUTE = read('app/api/platform-admin/reindex/route.ts');

test('ROUTE: the re-index route is adminCtx-gated on both verbs', () => {
  assert.match(ROUTE, /import \{ adminCtx \} from '\.\.\/_ctx'/);
  const get = ROUTE.slice(ROUTE.indexOf('export async function GET'), ROUTE.indexOf('export async function POST'));
  const post = ROUTE.slice(ROUTE.indexOf('export async function POST'));
  assert.match(get, /await adminCtx\(\)/, 'the status read is admin-only too');
  assert.match(post, /await adminCtx\(\)/);
});

test('ROUTE: it audits every call, and records a refusal as an error', () => {
  assert.match(ROUTE, /action: 'reindex\.plan'/);
  assert.match(ROUTE, /action: 'reindex\.run'/);
  assert.match(ROUTE, /result: 'error'/);
});

test('ROUTE: it forwards the refusal’s own code and status — review H3’s lesson', () => {
  assert.match(ROUTE, /\(e as \{ status\?: number \}\)\?\.status \?\? 500/);
  assert.match(ROUTE, /code \? \{ code \} : \{\}/);
  assert.match(ROUTE, /code: 'ENGINE_UNAVAILABLE'/);
});

test('ROUTE: it exports only handlers and the config name Next allows', () => {
  const exports = [...ROUTE.matchAll(/^export (?:async function|const) (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(exports.sort(), ['GET', 'POST', 'dynamic']);
});

test('ROUTE: the decision lives in the services, not in the route', () => {
  assert.match(ROUTE, /filesReindexService/);
  assert.match(ROUTE, /knowledgeReindexService/);
  assert.ok(!/refuseOfflineMock\(/.test(ROUTE), 'the refusal is the service’s, surfaced here');
});

test('REGISTRATION: the bundle injects both tab services into the kernel-side tool', () => {
  const reg = read('core/mcp/register-experimental.ts');
  const bundle = reg.slice(reg.indexOf("name: 'reindex'"), reg.indexOf("name: 'reindex'") + 700);
  assert.match(bundle, /import\('@core\/mcp\/reindex-tools'\)/);
  assert.match(bundle, /import\('@tabs\/files\/lib\/reindex'\)/);
  assert.match(bundle, /import\('@tabs\/knowledge\/lib\/reindex'\)/);
  assert.match(bundle, /reindexTools\(\{/);
  // The kernel-side tool module itself must not import a tab — that is the whole point.
  const toolSrc = read('core/mcp/reindex-tools.ts');
  assert.ok(!/@tabs\//.test(toolSrc), 'core/mcp/reindex-tools.ts must know no tab');
});

// ---------------------------------------------------------------------------
//  H3 · H2 · M4 at the doors
// ---------------------------------------------------------------------------

test('H3 (MCP): mode:"abandon" frees the target without planning, probing or writing', async () => {
  let planned = false;
  let ran = false;
  const out = (await tool(services({ onPlan: () => { planned = true; }, onRun: () => { ran = true; } })).call(admin, {
    target: 'files', mode: 'abandon',
  })) as { abandoned: boolean; job: { status: string; error: string | null } };
  assert.equal(planned, false, 'abandon never plans');
  assert.equal(ran, false, 'and never runs');
  assert.equal(out.abandoned, true);
  assert.equal(out.job.status, 'failed');
  assert.match(out.job.error!, /Abandoned by/);
});

test('H3 (MCP): abandoning when nothing runs is stated, not pretended', async () => {
  const out = (await tool(services({ abandon: { abandoned: false, job: null, reason: 'nothing-running' } })).call(admin, {
    target: 'knowledge', mode: 'abandon',
  })) as { abandoned: boolean; reason: string; job: unknown };
  assert.equal(out.abandoned, false);
  assert.equal(out.reason, 'nothing-running');
  assert.equal(out.job, null);
});

test('H3 (MCP): abandon is admin-only in-lib, like every other mode', async () => {
  await assert.rejects(
    () => tool().call(builder, { target: 'files', mode: 'abandon' }),
    (e: Error & { status?: number }) => e.status === 403,
  );
});

test('H2 (MCP): status reports inFlight separately from running', async () => {
  const out = (await tool(services({ inFlight: true })).call(admin, { target: 'files', status: true })) as {
    running: boolean; inFlight: boolean;
  };
  assert.equal(out.inFlight, true, 'the panel needs "a batch is executing" as its own fact');
  assert.equal(out.running, false, 'no job in this fresh table — the two are different questions');
});

test('M4 (MCP): a run on a RUNNING job resumes it and does not re-plan', async () => {
  __resetReindexJobs();
  // Claim the slot so the tool sees a running job for `files`.
  startOrResume('files', { filter: 'all', by: 'u_admin', total: 9 });
  let planned = 0;
  const seenPlans: (ReindexPlan | null)[] = [];
  const out = (await tool(
    services({
      onPlan: () => { planned += 1; },
      onRunPlan: (p) => seenPlans.push(p),
      run: { started: false, job: job({ cursor: 4, total: 9, filter: 'all' }), reason: 'resumed' },
    }),
  ).call(admin, { target: 'files', mode: 'run', filter: 'marked' })) as {
    started: boolean; reason: string; filter: string; job: { done: number };
  };
  assert.equal(planned, 0, 'no re-plan: that was a full index read per batch');
  assert.deepEqual(seenPlans, [null], 'the resume hands the service a null plan');
  assert.equal(out.started, false);
  assert.equal(out.reason, 'resumed');
  assert.equal(out.filter, 'all', 'the RUNNING job’s filter, not the request’s');
  assert.equal(out.job.done, 4);
  __resetReindexJobs();
});

test('M4 (MCP): a bad mode names what it got, including the new one', async () => {
  await assert.rejects(
    () => tool().call(admin, { target: 'files', mode: 'nuke' }),
    (e: Error & { status?: number }) => e.status === 400 && /"plan", "run" or "abandon" \(got "nuke"\)/.test(e.message),
  );
});

// ---------------------------------------------------------------------------
//  The HTTP door, for the same three
// ---------------------------------------------------------------------------

test('ROUTE: GET reports inFlight so the panel can tell "running" from "busy" (H2)', () => {
  assert.match(ROUTE, /inFlight: SERVICES\[target\]\.inFlight\(\)/);
});

test('ROUTE: mode:"abandon" is admin-gated, audited and writes nothing to the index (H3)', () => {
  assert.match(ROUTE, /body\.mode === 'abandon'/);
  assert.match(ROUTE, /service\.abandonReindex\(principal\)/);
  assert.match(ROUTE, /action: 'reindex\.abandon'/);
  const abandonBlock = ROUTE.slice(ROUTE.indexOf("if (mode === 'abandon')"), ROUTE.indexOf("// RESUME without re-planning"));
  assert.ok(!/planReindex/.test(abandonBlock), 'abandon must not plan');
});

test('ROUTE: a run against a RUNNING job resumes without re-planning (M4)', () => {
  const resumeBlock = ROUTE.slice(ROUTE.indexOf('// RESUME without re-planning'), ROUTE.indexOf('const plan = await service.planReindex'));
  assert.match(resumeBlock, /runReindex\(principal, null, \{ batch \}\)/);
  assert.ok(!/planReindex/.test(resumeBlock), 'the resume path must not plan');
});

test('ROUTE: the audit records the JOB’s filter, not the request’s (low 3)', () => {
  assert.match(ROUTE, /a \$\{out\.job\.filter\} re-index/);
});
