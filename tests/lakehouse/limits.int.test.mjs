// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// limits.int.test (WP-13, design 06 §5.5 / §7.1): the chart's resource groups and session
// defaults, on the chart's Trino image, decided by Trino itself and read back from Trino's own
// `system.runtime.queries.resource_group_id`, query state and QueryInfo.
//
//   bash tests/lakehouse/up.sh && node --test --test-concurrency=1 tests/lakehouse/limits.int.test.mjs
//
// Negative twins: an untagged query must FAIL the routing check (it lands in global.other), and
// an over-limit query must be QUEUED, not RUNNING, until a slot frees.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { run, hold, queries, until, info } from './lib.mjs';

const held = [];
after(async () => { await Promise.all(held.map((q) => q.cancel())); });
async function holdQ(opts) { const q = await hold(opts); held.push(q); return q; }
async function cancelAll() { await Promise.all(held.splice(0).map((q) => q.cancel())); }

/** os-ui's source tag, exactly as core/infra/trino-source.ts builds it. */
const osui = (domain, surface = 'data-query') => `os-ui/${domain}/${surface}`;

/** The routing check every positive test uses (and the negative twin must fail). */
async function assertOwnGroup(opts, expected) {
  const { id } = await run('SELECT 1', opts);
  const row = (await queries([id]))[id];
  assert.ok(row, `query ${id} not in system.runtime.queries`);
  assert.equal(row.rg, expected, `query from ${opts.user} (${opts.source ?? 'no source'}) landed in ${row.rg}`);
  return row;
}

test('domains A and B and user U land in their own groups (resource_group_id)', async () => {
  await assertOwnGroup({ user: 'u-alice', source: osui('sales') }, 'global.domains.sales.u-alice');
  await assertOwnGroup({ user: 'u-bob', source: osui('marketing', 'metrics') }, 'global.domains.marketing.u-bob');
  // Same domain, another user → a sibling group (limits are per user inside the domain).
  await assertOwnGroup({ user: 'u-carol', source: osui('sales') }, 'global.domains.sales.u-carol');
  // An e-mail-shaped uid (06 uid-mapping) keeps its dots inside its own segment.
  const r = await run('SELECT 1', { user: 'a.b@x.com', source: osui('sales') });
  const row = (await queries([r.id]))[r.id];
  assert.equal(row.rg, 'global.domains.sales.a.b@x.com');
  // A live-style domain id (sanitised by os-ui to [a-z0-9_]).
  await assertOwnGroup({ user: 'u-dave', source: osui('agentic_leader_q3_2026') }, 'global.domains.agentic_leader_q3_2026.u-dave');
});

test('dbt-trino, Dagster and seed sources land in global.system', async () => {
  await assertOwnGroup({ user: 'sales', source: 'dbt-trino-1.9.3' }, 'global.system');
  await assertOwnGroup({ user: 'sales', source: 'dagster/sales/observe' }, 'global.system');
  await assertOwnGroup({ user: 'northpeak-marts', source: 'os-seed/northpeak-marts' }, 'global.system');
});

test('NEGATIVE TWIN: a query without the source tag fails the routing check (global.other)', async () => {
  // The check itself must reject an untagged query...
  await assert.rejects(
    assertOwnGroup({ user: 'u-alice' }, 'global.domains.sales.u-alice'),
    /landed in global\.other/,
  );
  // ...and so must the old client-tag selector's input: tags alone select nothing any more.
  await assert.rejects(
    assertOwnGroup({ user: 'u-alice', source: 'trino-python-client', tags: ['domain=sales'] }, 'global.domains.sales.u-alice'),
    /landed in global\.other/,
  );
  // A source that only looks like os-ui's (upper case, not sanitised) is not captured either.
  await assert.rejects(assertOwnGroup({ user: 'u-alice', source: 'os-ui/Sales/x' }, 'global.domains.Sales.u-alice'), /landed in global\.other/);
});

test('per-user limit: the third concurrent query of a user is QUEUED, not run; another user still runs', async () => {
  const a = [await holdQ({ user: 'u-alice', source: osui('sales') }), await holdQ({ user: 'u-alice', source: osui('sales') })];
  await until(a.map((q) => q.id), (m) => a.every((q) => m[q.id]?.state === 'RUNNING'), 'two of alice running');
  const third = await holdQ({ user: 'u-alice', source: osui('sales') });
  const carol = await holdQ({ user: 'u-carol', source: osui('sales') });
  const m = await until([third.id, carol.id], (x) => x[third.id]?.state === 'QUEUED' && x[carol.id]?.state === 'RUNNING', 'third queued, carol running', 15000);
  assert.equal(m[third.id].rg, 'global.domains.sales.u-alice');
  // Hold the observation for a few seconds: QUEUED is a steady state, not a dispatch blip.
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal((await queries([third.id]))[third.id].state, 'QUEUED');
  // Twin: free one slot and the queued query runs.
  await a[0].cancel();
  await until([third.id], (x) => x[third.id]?.state === 'RUNNING', 'queued query starts after a slot frees');
  await cancelAll();
});

test('per-domain limit: domain A at its cap queues a new user; domain B is unaffected', async () => {
  // 4 users × 2 = 8 = the domain cap (values.yaml: domains.${domain}.hardConcurrencyLimit).
  const users = ['u1', 'u2', 'u3', 'u4'];
  const running = [];
  for (const u of users) for (let i = 0; i < 2; i++) running.push(await holdQ({ user: u, source: osui('sales') }));
  await until(running.map((q) => q.id), (m) => running.every((q) => m[q.id]?.state === 'RUNNING'), 'eight running in sales', 60000);
  const fifth = await holdQ({ user: 'u5', source: osui('sales') });
  const other = await holdQ({ user: 'u5', source: osui('marketing') });
  const m = await until([fifth.id, other.id], (x) => x[fifth.id]?.state === 'QUEUED' && x[other.id]?.state === 'RUNNING', 'sales full, marketing runs', 15000);
  assert.equal(m[fifth.id].rg, 'global.domains.sales.u5');
  assert.equal(m[other.id].rg, 'global.domains.marketing.u5');
  await cancelAll();
});

test('session defaults: a domain read gets the 60 s budget server-side; a system query gets 2 h', async () => {
  const read = await run('SELECT 1', { user: 'u-alice', source: osui('sales') });
  const p = (await info(read.id)).session.systemProperties;
  assert.equal(p.query_max_run_time, '60s');
  assert.equal(p.query_max_execution_time, '45s');
  assert.equal(p.query_max_scan_physical_bytes, '20GB');
  const sys = await run('SELECT 1', { user: 'sales', source: 'dbt-trino-1.9.3' });
  assert.equal((await info(sys.id)).session.systemProperties.query_max_run_time, '2h');
  // Twin: an untagged query gets no default from the domain rules.
  const other = await run('SELECT 1', { user: 'u-alice' });
  assert.equal((await info(other.id)).session.systemProperties.query_max_run_time, undefined);
});
