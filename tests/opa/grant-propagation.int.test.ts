/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * grant-propagation.int.test — 10 F3 on REAL components: postgres:17 with the WP-07 `os_governance`
 * schema (node-pg-migrate), and OPA 1.22.4 from the chart with both bundles (os-data plus the
 * long-polled os-grants), downloading from os-ui's REAL route handlers and POSTing status to
 * os-ui's REAL status route.
 *
 *  1. 50 run grants: each is committed in Postgres, then `waitForBundleRevision` returns only once
 *     OPA's own status report shows the revision that contains it; at that moment the grant IS in
 *     OPA (`data.os_grants.run_grants[id]`). p95 < 2 s.
 *  2. Approved writes travel with their grant; a revocation leaves OPA within 2 s.
 *  3. Restart OPA with os-ui down: every grant is still there (persisted bundle).
 *  4. Negative twins: the governance database unreachable → the route answers 503 and OPA keeps
 *     every grant (never an empty set); an instance that never reports status (as with no
 *     `status:` block) → `grant_not_propagated`, never a silent start.
 *
 * Run (from os-ui/): OS_PG_TEST_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *   node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test ../tests/opa/grant-propagation.int.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Opa, TOKEN, chartEnv, docker, fakeEmptyMirror, startBundleServer, startChartOpa, until, type BundleServer } from './bundle-it.ts';
import { seedOsState } from './fixture.ts';

// `pg` resolves from os-ui's own dependencies (this file lives outside os-ui/).
const pg = createRequire(new URL('../../os-ui/package.json', import.meta.url))('pg') as typeof import('pg');

const PORT = Number(process.env.OPA_IT_GRANTS_PORT ?? 18195);
const SERVER_PORT = Number(process.env.OPA_IT_GRANTS_SERVER_PORT ?? 18284);
const NAME = 'wp11-grants';
const opa = new Opa(`http://127.0.0.1:${PORT}`);
const SETS = [
  'opa.dataBundle.enabled=true',
  `opa.dataBundle.serviceUrl=http://host.docker.internal:${SERVER_PORT}/api/opa`,
  'postgres.governance.enabled=true',
  'postgres.governance.adminSecretName=it-only',
];

process.env.OPA_URL = opa.url;
process.env.OS_OPA_BUNDLE_TOKEN = TOKEN; // the dedicated bundle token (opa-bundle-token)
process.env.AGENT_RUNTIME_TOKEN = 'a-different-shared-runtime-token'; // never accepted by the bundle routes
process.env.OS_OPA_DATA_BUNDLE = '1';
process.env.OS_OPA_SEED = chartEnv('OS_OPA_SEED', ['opa.dataBundle.enabled=true']);
process.env.OS_OPA_SEED_PRINCIPALS = chartEnv('OS_OPA_SEED_PRINCIPALS');
await fakeEmptyMirror();
// Imported only now: these load os-ui's config, which must see the env above.
const { freshDatabase } = await import('../../os-ui/core/testing/postgres/it-support.ts');
const { migrateGovernance } = await import('../../os-ui/core/testing/postgres/unwrapped.ts');

let db: { url: string; drop: () => Promise<void> };
let client: InstanceType<typeof pg.Client>;
let server: BundleServer | null = null;
let stopBundle: (() => void) | undefined;

before(async () => {
  db = await freshDatabase('wp11_grants');
  await migrateGovernance({ databaseUrl: db.url, direction: 'up' });
  process.env.OS_GOVERNANCE_DATABASE_URL = db.url;
  client = new pg.Client({ connectionString: db.url });
  await client.connect();
  const rendered = docker('version', '--format', '{{.Server.Version}}');
  assert.ok(rendered);
  startChartOpa(NAME, PORT, SETS);
  server = await startBundleServer(SERVER_PORT);
});
after(async () => {
  stopBundle?.();
  await server?.close();
  docker('rm', '-f', NAME);
  const { closeGovernancePool } = await import('@core/adapters/postgres/pool');
  await closeGovernancePool();
  await client?.end();
  await db?.drop();
});

let n = 0;
async function insertGrant(extra: { approvedWrite?: boolean } = {}): Promise<{ id: string; rev: string }> {
  const id = `rg_it_${++n}`;
  await client.query('BEGIN');
  await client.query(
    `INSERT INTO os_governance.run_grants (id, kind, principal_uid, domain, system_id, scopes, issued_by, expires_at)
     VALUES ($1, 'run', $2, 'sales', 'sys_it', ARRAY['data.query'], 'u-approver', now() + interval '1 hour')`,
    [id, `u${n}`],
  );
  if (extra.approvedWrite) {
    await client.query(
      `INSERT INTO os_governance.approvals (id, kind, subject_kind, subject_id, domain, requested_by, status, approver_uid, decided_at)
       VALUES ($1, 'agent.write', 'run', $2, 'sales', $3, 'approved', 'u-approver', now())`,
      [`ap_${id}`, id, `u${n}`],
    );
    await client.query(
      `INSERT INTO os_governance.run_grant_approved_writes (grant_id, table_fqn, op, approval_id, expires_at)
       VALUES ($1, 'iceberg.sales.suppliers', 'insert', $2, now() + interval '1 hour')`,
      [id, `ap_${id}`],
    );
  }
  await client.query('COMMIT');
  const rev = (await client.query<{ rev: string }>('SELECT rev::text AS rev FROM os_governance.grant_revision WHERE id = 1')).rows[0].rev;
  return { id, rev };
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}

test('1. 50 grants: each is active in OPA (by its own status report) within 2 s, p95', async () => {
  await seedOsState({ users: 5, tables: 2 });
  const { startOsDataBundle } = await import('@core/policy/bundle');
  stopBundle = startOsDataBundle({ resyncMs: 60 * 60_000 });
  assert.equal(await until(() => opa.status(), (s) => s === 200, 60_000), 200, 'both bundles activated');
  const { waitForBundleRevision } = await import('@core/policy/opa-status');
  const times: number[] = [];
  for (let i = 0; i < 50; i++) {
    const t0 = Date.now();
    const g = await insertGrant();
    const r = await waitForBundleRevision('os-grants', g.rev, ['opa'], 10_000);
    assert.equal(r.ok, true, r.ok ? '' : r.detail);
    const ms = Date.now() - t0;
    times.push(ms);
    const inOpa = (await opa.data(`os_grants/run_grants/${g.id}`)) as { principal_uid?: string } | undefined;
    assert.equal(inOpa?.principal_uid, `u${n}`, `grant ${g.id} is in OPA the moment the wait returns`);
  }
  const p = p95(times);
  console.log(`[grants] propagation over 50 grants: p50 ${[...times].sort((a, b) => a - b)[24]} ms, p95 ${p} ms, max ${Math.max(...times)} ms`);
  assert.ok(p < 2000, `p95 ${p} ms < 2000 ms`);
});

test('2. approved writes travel with the grant; a revocation leaves OPA within 2 s', async () => {
  const { waitForBundleRevision } = await import('@core/policy/opa-status');
  const g = await insertGrant({ approvedWrite: true });
  assert.equal((await waitForBundleRevision('os-grants', g.rev, ['opa'], 5000)).ok, true);
  const doc = (await opa.data(`os_grants/run_grants/${g.id}`)) as { approved_writes: { table_fqn: string; op: string }[] };
  assert.deepEqual(doc.approved_writes.map((w) => [w.table_fqn, w.op]), [['iceberg.sales.suppliers', 'insert']]);
  const t0 = Date.now();
  await client.query(`UPDATE os_governance.run_grants SET revoked_at = now() WHERE id = $1`, [g.id]);
  const gone = await until(() => opa.data(`os_grants/run_grants/${g.id}`), (v) => v === undefined, 5000, 50);
  assert.equal(gone, undefined, 'revoked grant left OPA');
  assert.ok(Date.now() - t0 < 2000, `revocation propagated in ${Date.now() - t0} ms`);
});

test('3. restart OPA with os-ui down: every grant is still there', async () => {
  const before = await opa.data('os_grants/run_grants');
  assert.ok(Object.keys(before as object).length >= 50);
  await server!.close();
  server = null;
  docker('restart', '-t', '1', NAME);
  assert.equal(await until(() => opa.status(), (s) => s === 200, 30_000), 200);
  assert.deepEqual(await opa.data('os_grants/run_grants'), before, 'identical after the restart');
  server = await startBundleServer(SERVER_PORT);
});

test('4a. negative twin — governance database unreachable: 503, OPA keeps every grant', async () => {
  const before = await opa.data('os_grants/run_grants');
  const good = process.env.OS_GOVERNANCE_DATABASE_URL!;
  const { closeGovernancePool } = await import('@core/adapters/postgres/pool');
  await closeGovernancePool();
  process.env.OS_GOVERNANCE_DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/none';
  const { GET } = await import('../../os-ui/app/api/opa/bundles/os-grants.tar.gz/route.ts');
  const res = await GET(new Request('http://x/api/opa/bundles/os-grants.tar.gz', { headers: { authorization: `Bearer ${TOKEN}` } }));
  assert.equal(res.status, 503, 'never an empty grant set');
  await new Promise((r) => setTimeout(r, 5000));
  assert.deepEqual(await opa.data('os_grants/run_grants'), before, 'OPA kept its last good grants');
  assert.equal(await opa.status(), 200);
  await closeGovernancePool();
  process.env.OS_GOVERNANCE_DATABASE_URL = good;
});

test('4b. negative twin — no status report from an instance: grant_not_propagated, never a silent start', async () => {
  const { waitForBundleRevision } = await import('@core/policy/opa-status');
  const g = await insertGrant();
  const r = await waitForBundleRevision('os-grants', g.rev, ['opa', 'trino-sidecar'], 3000);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? '' : r.code, 'grant_not_propagated');
  assert.match(r.ok ? '' : r.detail, /trino-sidecar=no report/);
});
