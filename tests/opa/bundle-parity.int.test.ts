/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * bundle-parity.int.test — WP-11 migration proof (04 M2: "compileOsData() = the union of today's
 * PUTs"), on two REAL OPA 1.22.4 containers started from the chart:
 *   A  the chart's default (push mode): os-ui's reconciler PUTs every document, as live today;
 *   B  the chart with `opa.dataBundle.enabled=true`: OPA downloads os-ui's os-data bundle.
 * Both get the same os-ui state at the live install's scale. Asserted:
 *   - every document under the bundle's roots is identical on A and B;
 *   - every decision is identical: agentic.authz allow + decision for every principal × tool,
 *     and trino rowFilters / columnMask / allow for every governance principal × table × column.
 * Negative twin: B's bundle without the os-ui sources (seed only) differs from A — the comparison
 * can tell a faked bundle from the real one.
 *
 * Run (from os-ui/, docker + helm + python3 with pyyaml):
 *   node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test ../tests/opa/bundle-parity.int.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Opa, TOKEN, chartEnv, docker, fakeEmptyMirror, startBundleServer, startChartOpa, until, type BundleServer } from './bundle-it.ts';
import { seedOsState } from './fixture.ts';

const PORT_A = Number(process.env.OPA_IT_PUSH_PORT ?? 18191);
const PORT_B = Number(process.env.OPA_IT_BUNDLE_PORT ?? 18192);
const SERVER_PORT = Number(process.env.OPA_IT_SERVER_PORT ?? 18282);
const A = new Opa(`http://127.0.0.1:${PORT_A}`);
const B = new Opa(`http://127.0.0.1:${PORT_B}`);
const BUNDLE_SETS = ['opa.dataBundle.enabled=true', `opa.dataBundle.serviceUrl=http://host.docker.internal:${SERVER_PORT}/api/opa`];

process.env.OPA_URL = A.url;
process.env.OS_OPA_BUNDLE_TOKEN = TOKEN; // the dedicated bundle token (opa-bundle-token)
process.env.AGENT_RUNTIME_TOKEN = 'a-different-shared-runtime-token'; // never accepted by the bundle routes
process.env.OS_OPA_DATA_BUNDLE = ''; // push mode: the reconciler PUTs into A
process.env.OS_OPA_SEED = chartEnv('OS_OPA_SEED', ['opa.dataBundle.enabled=true']);
process.env.OS_OPA_SEED_PRINCIPALS = chartEnv('OS_OPA_SEED_PRINCIPALS');
await fakeEmptyMirror();

let server: BundleServer;
before(async () => {
  startChartOpa('wp11-parity-push', PORT_A, []);
  startChartOpa('wp11-parity-bundle', PORT_B, BUNDLE_SETS);
  await until(() => A.status('/health'), (s) => s === 200, 60_000);
  server = await startBundleServer(SERVER_PORT);
});
after(async () => {
  await server?.close();
  docker('rm', '-f', 'wp11-parity-push', 'wp11-parity-bundle');
});

const ROOTS = ['grants', 'seed_grants', 'requires_approval', 'governance/tables', 'governance/principals', 'os_data/users', 'os_data/app_grants'];

test('parity: the os-data bundle carries exactly what the push path writes, and decides the same', async () => {
  await seedOsState();
  const { reconcileOpaState } = await import('@core/policy/opa-reconcile');
  const pushed = await reconcileOpaState('boot');
  assert.equal(pushed.state, 'restored', pushed.detail);

  // B activates the bundle os-ui serves (first poll; OPA retries with backoff until it gets one).
  const ready = await until(() => B.status(), (s) => s === 200, 60_000);
  assert.equal(ready, 200, 'bundle-mode OPA activated os-data');

  for (const root of ROOTS) {
    let b = await B.data(root);
    if (root === 'seed_grants') {
      // The one intended difference: bundle mode adds OPA's own status-report grant to the seed.
      const { ['opa-status-reporter']: reporter, ...rest } = b as Record<string, string[]>;
      assert.deepEqual(reporter, ['opa_status_report'], 'bundle seed carries the status-report grant');
      b = rest;
    }
    assert.deepEqual(b, await A.data(root), `data.${root.replace(/\//g, '.')} identical`);
  }
  const grants = (await A.data('grants')) as Record<string, string[]>;
  const principals = (await A.data('governance/principals')) as Record<string, unknown>;
  const tables = (await A.data('governance/tables')) as Record<string, { sensitive_columns?: Record<string, string> }>;
  const seedGrants = (await A.data('seed_grants')) as Record<string, string[]>;
  console.log(`[parity] ${Object.keys(grants).length} grant principals, ${Object.keys(principals).length} governance principals, ${Object.keys(tables).length} governance tables`);
  assert.ok(Object.keys(grants).length >= 155 && Object.keys(tables).length >= 19 && Object.keys(principals).length >= 101, 'live-scale fixture');

  // agentic.authz: every principal × every tool anyone holds (+ one nobody holds).
  const tools = [...new Set([...Object.values(grants), ...Object.values(seedGrants)].flat()), 'web_fetch', 'no_such_tool'];
  const names = [...new Set([...Object.keys(grants), ...Object.keys(seedGrants), 'nobody'])]; // A's seed: no status-report principal
  let n = 0;
  for (const principal of names) {
    for (const tool of tools) {
      const input = { principal, tool };
      assert.deepEqual(await B.eval('agentic/authz/decision', input), await A.eval('agentic/authz/decision', input), `decision ${principal}/${tool}`);
      assert.deepEqual(await B.eval('agentic/authz/allow', input), await A.eval('agentic/authz/allow', input), `allow ${principal}/${tool}`);
      n += 2;
    }
  }
  // trino: every governance principal (+ an unknown user) × every governed table.
  for (const user of [...Object.keys(principals), 'nobody']) {
    for (const fqn of Object.keys(tables)) {
      const [catalogName, schemaName, tableName] = fqn.split('.');
      const ctx = { identity: { user, groups: [] } };
      const table = { catalogName, schemaName, tableName };
      for (const [path, action] of [
        ['trino/rowFilters', { operation: 'GetRowFilters', resource: { table } }],
        ['trino/allow', { operation: 'SelectFromColumns', resource: { table: { ...table, columns: ['id'] } } }],
        ['trino/allow', { operation: 'CreateTableAsSelect', resource: { table } }],
        ...Object.keys(tables[fqn].sensitive_columns ?? {}).map((columnName) => ['trino/columnMask', { operation: 'GetColumnMask', resource: { column: { ...table, columnName, columnType: 'varchar' } } }] as const),
      ] as const) {
        const input = { context: ctx, action };
        assert.deepEqual(await B.eval(path, input), await A.eval(path, input), `${path} ${user} ${fqn} ${action.operation}`);
        n++;
      }
    }
  }
  console.log(`[parity] ${n} decisions identical on the push-mode and the bundle-mode OPA`);
});

test('negative twin: a bundle of the chart seed alone is NOT what the push path holds', async () => {
  const { buildBundle } = await import('@core/policy/bundle');
  const seed = JSON.parse(process.env.OS_OPA_SEED!) as Record<string, unknown>;
  const fake = buildBundle('os-data', seed, ['grants', 'seed_grants', 'requires_approval', 'governance/tables', 'governance/principals', 'os_data']);
  assert.notDeepEqual(seed.grants, await A.data('grants'), 'the seed has no runtime grants document');
  assert.ok(fake.revision !== (await import('@core/policy/bundle')).osDataBundleStatus().revision, 'a seed-only bundle has a different revision');
});
