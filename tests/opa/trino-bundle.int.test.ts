/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * trino-bundle.int.test — the user-visible proof of WP-11 through REAL Trino 476: the chart's
 * Trino (its OPA access-control plugin and file rules, tests/opa/run-chart-trino.py) asks the
 * chart's OPA 1.22.4 in bundle mode, which downloads os-ui's os-data bundle from os-ui's REAL
 * route handler. The table `iceberg.sales.gold_northpeak_commerce` is chart-seeded as shared with
 * the domain `agentic-leader-q3-2026`; the member is a RUNTIME user (exists only in os-ui), the
 * exact kind of principal the 20 Nov incident lost.
 *
 *  1. The runtime member reads every row through Trino; a user OPA does not know reads none
 *     (the row filter is real, not faked).
 *  2. A member added later reads nothing, then — after the bundle carries them — every row.
 *  3. OPA restarted with os-ui DOWN: the same members still read every row through Trino.
 *
 * Run (from os-ui/): node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test ../tests/opa/trino-bundle.int.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Opa, TOKEN, chartEnv, docker, fakeEmptyMirror, sh, startBundleServer, startChartOpa, until, type BundleServer } from './bundle-it.ts';

const OPA_PORT = Number(process.env.OPA_IT_TRINO_OPA_PORT ?? 18196);
const TRINO_PORT = Number(process.env.OPA_IT_TRINO_PORT ?? 18197);
const SERVER_PORT = Number(process.env.OPA_IT_TRINO_SERVER_PORT ?? 18285);
const OPA_NAME = 'wp11-trino-opa';
const TRINO_NAME = 'wp11-trino';
const opa = new Opa(`http://127.0.0.1:${OPA_PORT}`);
const TRINO = `http://127.0.0.1:${TRINO_PORT}`;
const TABLE = 'iceberg.sales.gold_northpeak_commerce';
const DOMAIN = 'agentic-leader-q3-2026';

process.env.OPA_URL = opa.url;
process.env.AGENT_RUNTIME_TOKEN = TOKEN;
process.env.OS_OPA_DATA_BUNDLE = '1';
process.env.OS_OPA_SEED = chartEnv('OS_OPA_SEED', ['opa.dataBundle.enabled=true']);
process.env.OS_OPA_SEED_PRINCIPALS = chartEnv('OS_OPA_SEED_PRINCIPALS');
await fakeEmptyMirror();

let server: BundleServer | null = null;
let stopBundle: (() => void) | undefined;

before(async () => {
  startChartOpa(OPA_NAME, OPA_PORT, ['opa.dataBundle.enabled=true', `opa.dataBundle.serviceUrl=http://host.docker.internal:${SERVER_PORT}/api/opa`]);
  server = await startBundleServer(SERVER_PORT);
  spawnRm(TRINO_NAME);
  sh('python3', [fileURLToPath(new URL('./run-chart-trino.py', import.meta.url)), TRINO_NAME, String(TRINO_PORT),
    '--set', `trino.opa.uri=http://host.docker.internal:${OPA_PORT}`,
    '--set', 'trino.jvm.maxHeap=1536M', '--set', 'trino.query.maxMemory=512MB', '--set', 'trino.query.maxMemoryPerNode=512MB']);
});
after(async () => {
  stopBundle?.();
  await server?.close();
  spawnRm(OPA_NAME);
  spawnRm(TRINO_NAME);
});

function spawnRm(name: string): void {
  try {
    docker('rm', '-f', name);
  } catch {
    /* not running */
  }
}

/** Trino's client protocol: POST /v1/statement, then follow nextUri. */
async function sql(user: string, statement: string): Promise<unknown[][]> {
  let res = await fetch(`${TRINO}/v1/statement`, { method: 'POST', headers: { 'X-Trino-User': user }, body: statement });
  let body = (await res.json()) as { nextUri?: string; data?: unknown[][]; error?: { message: string } };
  const rows: unknown[][] = [];
  for (;;) {
    if (body.error) throw new Error(`Trino: ${body.error.message}`);
    if (body.data) rows.push(...body.data);
    if (!body.nextUri) return rows;
    res = await fetch(body.nextUri, { headers: { 'X-Trino-User': user } });
    body = (await res.json()) as typeof body;
  }
}

async function rowsSeenBy(user: string): Promise<number> {
  // Only Trino's start-up transient ("No nodes available") is retried; any other error fails.
  for (let i = 0; ; i++) {
    try {
      return Number((await sql(user, `SELECT count(*) FROM ${TABLE}`))[0][0]);
    } catch (err) {
      if (i >= 30 || !String(err).includes('No nodes available')) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

test('1. through Trino: the runtime member reads every row; an unknown user reads none', async () => {
  const { createUser, knownDomains } = await import('@tabs/admin/lib/users');
  const domains = await import('@tabs/admin/lib/domains');
  await domains.ensureHydrated(knownDomains);
  await createUser({ id: 'leader-rt', email: 'leader-rt@example.com', password: 'S0me-Long-Passphrase!', domains: [DOMAIN], role: 'creator' });
  const { registerOpaStateSources } = await import('../../os-ui/opa-state-sources.ts');
  registerOpaStateSources();
  const { startOsDataBundle } = await import('@core/policy/bundle');
  stopBundle = startOsDataBundle({ resyncMs: 60 * 60_000, debounceMs: 50 });
  assert.equal(await until(() => opa.status(), (s) => s === 200, 60_000), 200, 'OPA activated os-data');

  const up = await until(async () => (await fetch(`${TRINO}/v1/info`)).json() as Promise<{ starting: boolean }>, (i) => i?.starting === false, 180_000, 1000);
  assert.equal(up?.starting, false, 'Trino started');
  // The writer is not a governed principal (unknown to data.governance), so trino.rego's write floor does not apply.
  // `starting:false` comes a moment before the memory catalog is ready on the node ("No nodes
  // available"), so the setup statements retry (both are idempotent).
  const load = async () => {
    await sql('it-loader', 'CREATE SCHEMA IF NOT EXISTS iceberg.sales');
    await sql('it-loader', `CREATE TABLE IF NOT EXISTS ${TABLE} AS SELECT * FROM (VALUES (1, 'a'), (2, 'b'), (3, 'c')) AS t(id, v)`);
    return true;
  };
  assert.equal(await until(load, (v) => v === true, 90_000, 1000), true, 'Trino loaded the test table');

  assert.equal(await rowsSeenBy('leader-rt'), 3, 'runtime member of the shared domain reads all rows');
  assert.equal(await rowsSeenBy('nobody-known'), 0, 'a user OPA does not know reads zero rows');
});

test('2. a member added later reads nothing, then every row once the bundle carries them', async () => {
  assert.equal(await rowsSeenBy('leader-late'), 0, 'not a member yet');
  const { createUser } = await import('@tabs/admin/lib/users');
  const { recompile } = await import('../../os-ui/app/api/platform-admin/_compile.ts');
  const t0 = Date.now();
  await createUser({ id: 'leader-late', email: 'leader-late@example.com', password: 'S0me-Long-Passphrase!', domains: [DOMAIN], role: 'creator' });
  await recompile();
  const n = await until(() => rowsSeenBy('leader-late'), (v) => v === 3, 25_000, 500);
  console.log(`[trino] new member reads through Trino after ${Date.now() - t0} ms`);
  assert.equal(n, 3);
});

test('3. OPA restarted with os-ui DOWN: Trino still lets every member read', async () => {
  await server!.close();
  server = null;
  docker('restart', '-t', '1', OPA_NAME);
  assert.equal(await until(() => opa.status(), (s) => s === 200, 30_000), 200, 'OPA ready from its persisted bundle');
  assert.equal(await rowsSeenBy('leader-rt'), 3, 'runtime member after the restart');
  assert.equal(await rowsSeenBy('leader-late'), 3, 'late member after the restart');
  assert.equal(await rowsSeenBy('nobody-known'), 0, 'still never fails open');
});
