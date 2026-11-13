/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Dagster client tests — every operation against a fake GraphQL endpoint
 * USER STORY: As a maintainer I want proof that a launch sends the job, the asset subset, the OS
 *             tags and the run-pod env; that each read maps Dagster's unions to typed data; and
 *             that HTTP errors, GraphQL errors, unexpected unions and timeouts all come back as
 *             `{ok:false}` — never a throw, never invented data.
 * ARCHITECTURE:
 *   - A scripted `fetch` records requests and answers per operation name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  launchRun, run, runsForDataset, recentOsRuns, assetChecks, allAssetChecks, latestMaterialization,
  assetGraph, reloadLocation, nextTick, k8sEnvTag, sanitizeName, sanitizeAll, scheduleNameFor, gql,
} from '@core/infra/dagster';

type Req = { query: string; variables: Record<string, unknown> };

function fakeFetch(answer: (req: Req) => unknown, opts: { status?: number; hang?: boolean } = {}) {
  const calls: Req[] = [];
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Req;
    calls.push(body);
    if (opts.hang) {
      await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    return new Response(JSON.stringify(answer(body)), { status: opts.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const deps = (f: typeof fetch) => ({ fetch: f, url: 'http://dagster', location: 'sovereign', repository: '__repository__' });

test('launchRun sends job, asset subset, tags and the run-pod env as dagster-k8s/config; maps success', async () => {
  const { fetch: f, calls } = fakeFetch(() => ({ data: { launchRun: { __typename: 'LaunchRunSuccess', run: { runId: 'r1', status: 'QUEUED', jobName: 'sales__all', tags: [] } } } }));
  const r = await launchRun({ domain: 'sales', selection: [['sales', 'gold_orders']], tags: { 'os/dataset': 'ds_1', 'os/principal': 'amir' }, env: { OS_PRINCIPAL: 'amir', OS_PINNED_COMMITS: 'sales=abc' } }, deps(f));
  assert.deepEqual(r, { ok: true, data: { runId: 'r1', status: 'QUEUED' } });
  const params = calls[0].variables.params as Record<string, Record<string, unknown>>;
  assert.equal(params.selector.jobName, 'sales__all');
  assert.equal(params.selector.repositoryLocationName, 'sovereign');
  assert.deepEqual(params.selector.assetSelection, [{ path: ['sales', 'gold_orders'] }]);
  const tags = Object.fromEntries((params.executionMetadata.tags as { key: string; value: string }[]).map((t) => [t.key, t.value]));
  assert.equal(tags['os/dataset'], 'ds_1');
  assert.deepEqual(JSON.parse(tags['dagster-k8s/config']), { container_config: { env: [{ name: 'OS_PINNED_COMMITS', value: 'sales=abc' }, { name: 'OS_PRINCIPAL', value: 'amir' }] } });
});

test('launchRun maps every failure union to {ok:false} and needs a job', async () => {
  const { fetch: f } = fakeFetch(() => ({ data: { launchRun: { __typename: 'InvalidSubsetError', message: 'no asset gold_x' } } }));
  assert.deepEqual(await launchRun({ domain: 'sales', selection: [['sales', 'gold_x']] }, deps(f)), { ok: false, error: 'InvalidSubsetError: no asset gold_x' });
  const { fetch: g } = fakeFetch(() => ({ data: { launchRun: { __typename: 'RunConfigValidationInvalid', errors: [{ message: 'bad' }] } } }));
  assert.equal((await launchRun({ jobName: 'j' }, deps(g))).ok, false);
  assert.deepEqual(await launchRun({}, deps(f)), { ok: false, error: 'launchRun needs a jobName or a domain' });
});

test('gql: HTTP error, GraphQL errors, empty data and timeout are results, not throws', async () => {
  const { fetch: f500 } = fakeFetch(() => ({}), { status: 503 });
  assert.deepEqual(await gql('query { x }', {}, deps(f500)), { ok: false, error: 'HTTP 503' });
  const { fetch: ferr } = fakeFetch(() => ({ errors: [{ message: 'Cannot query field' }] }));
  assert.deepEqual(await gql('query { x }', {}, deps(ferr)), { ok: false, error: 'Cannot query field' });
  const { fetch: fempty } = fakeFetch(() => ({}));
  assert.deepEqual(await gql('query { x }', {}, deps(fempty)), { ok: false, error: 'empty GraphQL response' });
  const { fetch: fhang } = fakeFetch(() => ({}), { hang: true });
  const r = await gql('query { x }', {}, { ...deps(fhang), timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /timeout after 20ms/);
  assert.deepEqual(await gql('query { x }', {}, { fetch: fempty, url: '' }), { ok: false, error: 'Dagster is not configured' });
});

test('run + runsForDataset map Dagster runs (unix seconds → ISO, tags → map, selection → paths)', async () => {
  const runDoc = { id: 'r2', runId: 'r2', status: 'SUCCESS', jobName: 'sales__ds_1', startTime: 1_700_000_000, endTime: 1_700_000_060, tags: [{ key: 'os/dataset', value: 'ds_1' }, { key: 'os/principal', value: 'bea' }], assetSelection: [{ path: ['sales', 'silver_events'] }] };
  const { fetch: f } = fakeFetch(() => ({ data: { runOrError: { __typename: 'Run', ...runDoc } } }));
  const r = await run('r2', deps(f));
  assert.ok(r.ok);
  assert.deepEqual(r.data, { runId: 'r2', status: 'SUCCESS', jobName: 'sales__ds_1', startedAt: '2023-11-14T22:13:20.000Z', endedAt: '2023-11-14T22:14:20.000Z', tags: { 'os/dataset': 'ds_1', 'os/principal': 'bea' }, assetSelection: ['sales/silver_events'] });

  const { fetch: g, calls } = fakeFetch(() => ({ data: { runsOrError: { __typename: 'Runs', results: [runDoc, { ...runDoc, runId: 'r1', status: 'FAILURE', endTime: null }] } } }));
  const rs = await runsForDataset('ds_1', 5, deps(g));
  assert.ok(rs.ok);
  assert.deepEqual(rs.data.map((x) => [x.runId, x.status, x.endedAt]), [['r2', 'SUCCESS', '2023-11-14T22:14:20.000Z'], ['r1', 'FAILURE', null]]);
  assert.deepEqual(calls[0].variables, { filter: { tags: [{ key: 'os/dataset', value: 'ds_1' }] }, limit: 5 });

  const { fetch: h } = fakeFetch(() => ({ data: { runOrError: { __typename: 'RunNotFoundError', message: 'nope' } } }));
  assert.deepEqual(await run('zz', deps(h)), { ok: false, error: 'RunNotFoundError: nope' });
  const { fetch: k } = fakeFetch(() => ({ data: { runsOrError: { __typename: 'Runs', results: [] } } }));
  assert.deepEqual(await recentOsRuns(10, deps(k)), { ok: true, data: [] });
});

test('assetChecks + allAssetChecks map dbt tests to typed checks with failed-row metadata', async () => {
  const check = { name: 'not_null_gold_orders_order_id', description: 'dbt test', executionForLatestMaterialization: { runId: 'r3', status: 'FAILED', timestamp: 1_700_000_000, evaluation: { severity: 'ERROR', description: '3 rows', metadataEntries: [{ label: 'dagster_dbt/failed_row_count', intValue: 3 }, { label: 'note', text: 'x' }] } } };
  const never = { name: 'unique_x', description: null, executionForLatestMaterialization: null };
  const { fetch: f, calls } = fakeFetch(() => ({ data: { assetChecksOrError: { __typename: 'AssetChecks', checks: [check, never] } } }));
  const r = await assetChecks(['sales', 'gold_orders'], deps(f));
  assert.ok(r.ok);
  assert.deepEqual(calls[0].variables, { key: { path: ['sales', 'gold_orders'] } });
  assert.deepEqual(r.data[0], { name: 'not_null_gold_orders_order_id', description: 'dbt test', latest: { status: 'FAILED', runId: 'r3', at: '2023-11-14T22:13:20.000Z', severity: 'ERROR', description: '3 rows', metadata: { 'dagster_dbt/failed_row_count': 3, note: 'x' } } });
  assert.deepEqual(r.data[1], { name: 'unique_x', description: null, latest: null });

  const { fetch: g } = fakeFetch(() => ({ data: { assetNodes: [{ assetKey: { path: ['sales', 'gold_orders'] }, assetChecksOrError: { __typename: 'AssetChecks', checks: [check] } }, { assetKey: { path: ['sales', 'silver_x'] }, assetChecksOrError: { __typename: 'AssetCheckNeedsMigrationError' } }] } }));
  const all = await allAssetChecks(deps(g));
  assert.ok(all.ok);
  assert.deepEqual(Object.keys(all.data), ['sales/gold_orders']);
});

test('latestMaterialization: ms timestamps → ISO; never materialized / unknown asset → null data', async () => {
  const { fetch: f } = fakeFetch(() => ({ data: { assetOrError: { __typename: 'Asset', assetMaterializations: [{ runId: 'r9', timestamp: '1700000000000' }] } } }));
  assert.deepEqual(await latestMaterialization(['sales', 'gold_orders'], deps(f)), { ok: true, data: { runId: 'r9', at: '2023-11-14T22:13:20.000Z' } });
  const { fetch: g } = fakeFetch(() => ({ data: { assetOrError: { __typename: 'Asset', assetMaterializations: [] } } }));
  assert.deepEqual(await latestMaterialization(['sales', 'x'], deps(g)), { ok: true, data: null });
  const { fetch: h } = fakeFetch(() => ({ data: { assetOrError: { __typename: 'AssetNotFoundError', message: 'no' } } }));
  assert.deepEqual(await latestMaterialization(['sales', 'x'], deps(h)), { ok: true, data: null });
});

test('assetGraph, reloadLocation and nextTick map their unions', async () => {
  const { fetch: f } = fakeFetch(() => ({ data: { assetNodes: [{ assetKey: { path: ['sales', 'gold_o'] }, dependencyKeys: [{ path: ['sales', 'silver_o'] }], groupName: 'sales', description: null }] } }));
  const g = await assetGraph(deps(f));
  assert.ok(g.ok);
  assert.deepEqual(g.data, [{ key: ['sales', 'gold_o'], dependsOn: [['sales', 'silver_o']], group: 'sales', description: null }]);

  const { fetch: ok, calls } = fakeFetch(() => ({ data: { reloadRepositoryLocation: { __typename: 'WorkspaceLocationEntry', name: 'sovereign' } } }));
  assert.deepEqual(await reloadLocation(undefined, deps(ok)), { ok: true, data: { name: 'sovereign' } });
  assert.deepEqual(calls[0].variables, { n: 'sovereign' });
  const { fetch: nf } = fakeFetch(() => ({ data: { reloadRepositoryLocation: { __typename: 'RepositoryLocationNotFound', message: 'x' } } }));
  assert.equal((await reloadLocation('other', deps(nf))).ok, false);

  const { fetch: s, calls: sc } = fakeFetch(() => ({ data: { scheduleOrError: { __typename: 'Schedule', name: 'sales__ds_1', cronSchedule: '0 6 * * *', executionTimezone: 'UTC', scheduleState: { status: 'RUNNING' }, futureTicks: { results: [{ timestamp: 1_700_000_000 }] } } } }));
  assert.deepEqual(await nextTick('sales__ds_1', deps(s)), { ok: true, data: { name: 'sales__ds_1', cron: '0 6 * * *', timezone: 'UTC', status: 'RUNNING', nextTickAt: '2023-11-14T22:13:20.000Z' } });
  assert.deepEqual(sc[0].variables, { sel: { repositoryLocationName: 'sovereign', repositoryName: '__repository__', scheduleName: 'sales__ds_1' } });
  const { fetch: stopped } = fakeFetch(() => ({ data: { scheduleOrError: { __typename: 'Schedule', name: 'n', cronSchedule: '* * * * *', scheduleState: { status: 'STOPPED' }, futureTicks: { results: [{ timestamp: 1 }] } } } }));
  const t = await nextTick('n', deps(stopped));
  assert.ok(t.ok);
  assert.equal(t.data.status, 'STOPPED');
  assert.equal(t.data.nextTickAt, null);
  const { fetch: missing } = fakeFetch(() => ({ data: { scheduleOrError: { __typename: 'ScheduleNotFoundError', message: 'none' } } }));
  assert.deepEqual(await nextTick('n', deps(missing)), { ok: false, error: 'ScheduleNotFoundError: none' });
});

test('naming helpers match os_projects.py', () => {
  assert.equal(sanitizeName('agentic-leader q3'), 'agentic_leader_q3');
  assert.equal(sanitizeName('9x'), '_9x');
  assert.equal(scheduleNameFor('sales', 'ds_ab12'), 'sales__ds_ab12');
  assert.equal(k8sEnvTag({ B: '2', A: '1' }), JSON.stringify({ container_config: { env: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }] } }));
});

test('sanitizeAll agrees with os_projects.sanitize_all on the SHARED golden (engine rebuild B3)', () => {
  // The same file `images/extensions/dagster/tests/test_os_projects.py::SanitizeGolden` asserts
  // against, so a change to the collision rule fails in CI on whichever side forgot it.
  const golden = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'images', 'extensions', 'dagster', 'tests', 'sanitize-collisions.golden.json'), 'utf8'),
  ) as { inputs: string[]; expected: Record<string, string> };
  assert.deepEqual(sanitizeAll(golden.inputs), golden.expected);
});

test('a collided domain gets the schedule name the code location really defined', () => {
  // Before B3 the OS computed the plain form for BOTH, so `nextTick` asked for a schedule that did
  // not exist and the panel showed no next tick (review B2-review-M2's recorded consequence).
  const domains = ['sales-eu', 'sales.eu'];
  const names = sanitizeAll(domains);
  assert.notEqual(names['sales-eu'], names['sales.eu'], 'the collision is resolved, not shared');
  assert.equal(scheduleNameFor('sales.eu', 'ds_ab12', domains), `${names['sales.eu']}__ds_ab12`);
  assert.equal(scheduleNameFor('sales-eu', 'ds_ab12', domains), 'sales_eu__ds_ab12');
  // No list ⇒ the plain form, which is right whenever nothing collides and is what pre-B3 did.
  assert.equal(scheduleNameFor('sales.eu', 'ds_ab12'), 'sales_eu__ds_ab12');
  assert.equal(scheduleNameFor('sales', 'ds_ab12', ['sales', 'finance']), 'sales__ds_ab12');
});
