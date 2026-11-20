/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    AT-b journey-b-dataproduct.e2e — Postgres source via dlt → bronze/silver/gold in
 *             Dagster on a schedule → quality check → Iceberg version → metric → tile → viewers
 * USER STORY: As the owner I want proof that a data product runs in Dagster on its schedule AS
 *             its owner, that its quality rule is a Dagster asset check, that each run is an
 *             Iceberg snapshot, and that the tile query runs in Trino AS the viewer with MetricFlow's
 *             compiled SQL, so viewer V (DE) sees only DE rows and W (FR) only FR rows.
 * ARCHITECTURE:
 *   - Authoritative: 09 §5 AT-b; MASTER-PLAN Part 2 §C row AT-b; 10 F4/F5/F6/F7/F13.
 *   - Records: Dagster GraphQL (runs, tags, asset checks), OPA sidecar decision log (VictoriaLogs),
 *     Trino system.runtime.queries and "$snapshots", metric-compile's response, git receive.
 *   - Fixture source: a throwaway Postgres pod `e2e-source-pg` in the namespace (purchase orders,
 *     regions DE and FR), connected through the OS like a user would (dlt sql_database, WP-18).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { journey, check } from '../lib/journey.mjs';
import { PRINCIPALS, DOMAIN, waitFor, isoNow } from '../lib/common.mjs';
import { callTool } from '../lib/os-driver.mjs';
import * as dagster from '../lib/records/dagster.mjs';
import * as trino from '../lib/records/trino.mjs';
import * as opa from '../lib/records/opa.mjs';
import * as git from '../lib/records/git.mjs';
import { baseUrl } from '../lib/endpoints.mjs';
import { request, basic } from '../lib/http.mjs';
import { kubectl, execIn, NS } from '../lib/kube.mjs';
import { HopError } from '../lib/hop.mjs';

const { U, V, W } = PRINCIPALS;
const J = journey('AT-b', 'journey-b-dataproduct');
const SOURCE_IMAGE = process.env.E2E_SOURCE_PG_IMAGE ?? 'postgres:17@sha256:5c855ad7b85e68e48a62f34662853f38b57c1c1d80f3a927ab58034fd6d31c5e';
const GOLD = { catalog: 'iceberg', schema: DOMAIN, table: 'gold_po' };
const ASSET_PATH = (process.env.E2E_GOLD_ASSET ?? `${DOMAIN}/gold_po`).split('/');
const CHECK_NAME = 'po_number_not_null';
const RUNNER_USER = process.env.E2E_DAGSTER_RUNNER_USER ?? 'svc-dagster-runner';
const RUNNER_SECRET = process.env.E2E_DAGSTER_RUNNER_SECRET ?? 'trino-svc-dagster-runner';
const trinoTs = (iso) => iso.replace('T', ' ').slice(0, 19);
const allowed = (e) => e.result === true || e.result?.allow === true;

// ---------------------------------------------------------------- fixture source (a real Postgres)
const SOURCE_SQL = `
create table if not exists purchase_orders (po_number text, region text, amount numeric, ordered_at timestamptz default now());
truncate purchase_orders;
insert into purchase_orders (po_number, region, amount) values
  ('PO-1001','DE',120.50),('PO-1002','DE',80.00),('PO-1003','FR',42.10),('PO-1004','FR',300.00),('PO-1005','DE',15.25);`;

async function sourcePg() {
  const pod = {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name: 'e2e-source-pg', namespace: NS, labels: { 'app.kubernetes.io/name': 'e2e-source-pg', 'app.kubernetes.io/part-of': 'e2e-harness' } },
    spec: { containers: [{ name: 'pg', image: SOURCE_IMAGE, env: [{ name: 'POSTGRES_PASSWORD', value: 'e2e-source' }, { name: 'POSTGRES_DB', value: 'erp' }], ports: [{ containerPort: 5432 }] }] },
  };
  const svc = { apiVersion: 'v1', kind: 'Service', metadata: { name: 'e2e-source-pg', namespace: NS }, spec: { selector: { 'app.kubernetes.io/name': 'e2e-source-pg' }, ports: [{ port: 5432 }] } };
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [pod, svc] }) });
  await kubectl(['-n', NS, 'wait', '--for=condition=Ready', 'pod/e2e-source-pg', '--timeout=180s'], { timeoutMs: 200000 });
  await waitFor(async () => { await execIn('e2e-source-pg', ['pg_isready', '-U', 'postgres']); return true; }, { component: 'e2e-source-pg', hop: 'ready', what: 'pg_isready', timeoutMs: 60000 });
  await execIn('e2e-source-pg', ['psql', '-U', 'postgres', '-d', 'erp', '-v', 'ON_ERROR_STOP=1', '-c', SOURCE_SQL]);
}

// ---------------------------------------------------------------- steps (cause the hops through the OS)
const source = () => J.step('source', sourcePg);
const product = () => J.step('data product', async () => {
  await source();
  const conn = await callTool(U, 'create_connection', { name: 'e2e-erp', domain: DOMAIN, type: 'postgres', config: { host: 'e2e-source-pg', port: 5432, database: 'erp', user: 'postgres', password: 'e2e-source' } });
  const ds = await callTool(U, 'create_dataset', { name: 'gold_po', domain: DOMAIN, connectionId: conn.id, sourceTable: 'public.purchase_orders' });
  await callTool(U, 'define_quality_rules', { datasetId: ds.id, rules: [{ column: 'po_number', test: 'not_null' }] });
  await callTool(U, 'set_dataset_sync', { datasetId: ds.id, cron: '* * * * *' });
  const metric = await callTool(U, 'define_metric', { datasetId: ds.id, name: 'po_count', measure: { agg: 'count', expr: 'po_number' }, dimensions: ['region'] });
  const dash = await callTool(U, 'create_dashboard', { name: 'e2e-po', domain: DOMAIN, tiles: [{ metric: metric.id, groupBy: ['region'] }] });
  return { conn, ds, metric, dash, createdAt: isoNow() };
});

/** First schedule-launched run of the dataset after `since`, waited to a terminal state. */
async function nextScheduleRun(datasetId, since) {
  const run = await waitFor(async () => {
    const rs = await dagster.runs({ tags: { 'os/dataset': datasetId } });
    return rs.find((r) => r.tagMap['dagster/schedule_name'] && r.startTime * 1000 >= Date.parse(since));
  }, { component: 'dagster', hop: 'schedule tick', what: `a schedule-launched run for ${datasetId}`, timeoutMs: 300000 });
  const done = await dagster.waitForRun(run.runId);
  return { ...run, status: done.status };
}
const firstRun = () => J.step('first scheduled run', async () => {
  const p = await product();
  const before = await trino.snapshots(GOLD.catalog, GOLD.schema, GOLD.table).catch(() => []);
  const run = await nextScheduleRun(p.ds.id, p.createdAt);
  const [fresh] = await dagster.runs({ tags: { 'os/dataset': p.ds.id } }).then((rs) => rs.filter((r) => r.runId === run.runId));
  return { p, run: { ...run, endTime: fresh?.endTime ?? run.endTime }, snapshotsBefore: before.length };
});
const nullRowRun = () => J.step('run after a null po_number', async () => {
  const { p } = await firstRun();
  const since = isoNow();
  await execIn('e2e-source-pg', ['psql', '-U', 'postgres', '-d', 'erp', '-c', "insert into purchase_orders (po_number, region, amount) values (null,'DE',1)"]);
  return { run: await nextScheduleRun(p.ds.id, since), p };
});

async function tileFor(viewer) {
  const { p } = await firstRun();
  const since = isoNow();
  const res = await callTool(viewer, 'query_metric', { metricId: p.metric.id, groupBy: ['region'] });
  return { res, since, p };
}
const tileV = () => J.step('tile as V', () => tileFor(V));
const tileW = () => J.step('tile as W', () => tileFor(W));

/** [start, end] in ms of every Dagster run of the dataset, from Dagster's own ledger. */
async function runWindows(datasetId) {
  const rs = await dagster.runs({ tags: { 'os/dataset': datasetId }, limit: 200 });
  return rs.filter((r) => r.startTime).map((r) => ({ runId: r.runId, from: r.startTime * 1000, to: (r.endTime ?? Date.now() / 1000) * 1000 + 5000 }));
}
const within = (ts, w) => ts >= w.from && ts <= w.to;

// ---------------------------------------------------------------- 1. Dagster
J.assertion('b1.1', { hop: 'schedule-launched run SUCCESS, tagged os/principal and os/run_grant', record: 'Dagster GraphQL runsOrError', expectedFail: 'WP-49' }, async () => {
  const { run } = await firstRun();
  check(run.status === 'SUCCESS', 'dagster', 'run status SUCCESS', run.status);
  check(run.tagMap['dagster/schedule_name'], 'dagster', 'run launched by a schedule (dagster/schedule_name tag)', run.tagMap);
  check(run.tagMap['os/principal'] === U, 'dagster', `tag os/principal=${U}`, run.tagMap['os/principal']);
  check(/\S/.test(run.tagMap['os/run_grant'] ?? ''), 'dagster', 'tag os/run_grant present', run.tagMap);
});

J.assertion('b1.2', { hop: `asset check ${CHECK_NAME} PASSED`, record: 'Dagster GraphQL assetCheckExecutions', expectedFail: 'WP-19' }, async () => {
  const { run } = await firstRun();
  const ex = (await dagster.assetCheckExecutions(ASSET_PATH, CHECK_NAME)).find((e) => e.runId === run.runId);
  check(ex, 'dagster', `a ${CHECK_NAME} execution in run ${run.runId}`, null);
  check(ex.status === 'SUCCEEDED' && ex.evaluation?.success === true, 'dagster', 'check SUCCEEDED with success=true', ex);
});

J.assertion('b1.3', { hop: `after a null row ${CHECK_NAME} FAILED and the tile turns red`, record: 'Dagster GraphQL assetCheckExecutions + OS tile status', expectedFail: 'WP-19' }, async () => {
  const { run, p } = await nullRowRun();
  const ex = (await dagster.assetCheckExecutions(ASSET_PATH, CHECK_NAME)).find((e) => e.runId === run.runId);
  check(ex && ex.evaluation?.success === false, 'dagster', `check failed in run ${run.runId}`, ex);
  const dash = await callTool(U, 'get_dashboard', { id: p.dash.id });
  const tile = dash.tiles?.[0];
  check(tile?.quality?.status === 'failed' && tile.quality.dagsterRunId === run.runId, 'os-ui', 'tile shows the FAILED check from that Dagster run', tile?.quality);
});

// ---------------------------------------------------------------- 2. identity
J.assertion('b2.1', { hop: `ImpersonateUser ${RUNNER_USER} → owner allowed only while a run of the dataset is active`, record: 'OPA (Trino sidecar) decision log + Dagster run ledger', expectedFail: 'WP-15' }, async () => {
  // Scoped to Dagster's own run windows, not to wall-clock: later schedule ticks are runs too, so
  // they can never make this red; an allowed impersonation OUTSIDE every run window always does.
  const { run, p } = await firstRun();
  const windows = await runWindows(p.ds.id);
  const first = windows.find((w) => w.runId === run.runId);
  check(first, 'dagster', `run ${run.runId} in the dataset's run ledger`, windows.map((w) => w.runId));
  const ds = await opa.decisions({ match: (e) => e.input?.action?.operation === 'ImpersonateUser' && e.input?.context?.identity?.user === RUNNER_USER && e.input?.action?.resource?.user?.user === U });
  check(ds.some((e) => within(Date.parse(e.timestamp), first) && allowed(e)), 'opa', `an allowed ImpersonateUser ${RUNNER_USER} → ${U} inside run ${run.runId}`, ds.length);
  const stray = ds.filter((e) => allowed(e) && !windows.some((w) => within(Date.parse(e.timestamp), w)));
  check(stray.length === 0, 'opa', 'no allowed impersonation outside every run window of the dataset', stray.map((e) => e.decision_id));
});

J.assertion('b2.2', { hop: 'after /finish the same impersonation with the runner password is denied', record: 'Trino error + OPA decision log', expectedFail: 'WP-15' }, async () => {
  const { run } = await firstRun();
  check(run.endTime, 'dagster', 'run finished', run.status);
  const secret = JSON.parse(await kubectl(['-n', NS, 'get', 'secret', RUNNER_SECRET, '-o', 'json']));
  const password = Buffer.from(secret.data.password ?? Object.values(secret.data)[0], 'base64').toString();
  const auth = { authorization: basic(RUNNER_USER, password), 'X-Trino-User': U, 'X-Trino-Source': 'e2e-debug-pod' };
  const res = await request('trino', 'statement as runner impersonating owner', `${await baseUrl('trino')}/v1/statement`, {
    method: 'POST', body: `select count(*) from ${GOLD.catalog}.${GOLD.schema}.${GOLD.table}`, headers: auth, okStatus: [401, 403],
  });
  let data = res.data;
  while (data?.nextUri && !data.error) ({ data } = await request('trino', 'follow', data.nextUri, { headers: auth }));
  check(res.status >= 400 || /ACCESS_DENIED|PERMISSION_DENIED|impersonat/i.test(JSON.stringify(data?.error ?? '')), 'trino', 'impersonation after /finish is denied', data?.error ?? res.status);
  const denied = await opa.decisions({ sinceMinutes: 10, match: (e) => e.input?.action?.operation === 'ImpersonateUser' && e.input?.action?.resource?.user?.user === U && !allowed(e) });
  check(denied.length > 0, 'opa', 'a deny decision for that impersonation', 0);
});

// ---------------------------------------------------------------- 3. Iceberg
J.assertion('b3.1', { hop: 'the first run committed exactly one gold_po snapshot, and no snapshot exists outside a run', record: 'Trino Iceberg $snapshots + Dagster run ledger', expectedFail: 'WP-37' }, async () => {
  // Deterministic under later schedule ticks: each snapshot is attributed to the run whose window
  // holds it (Dagster's ledger); the first run must own exactly one, and none may be orphaned.
  const { run, p, snapshotsBefore } = await firstRun();
  const windows = await runWindows(p.ds.id);
  const first = windows.find((w) => w.runId === run.runId);
  check(first, 'dagster', `run ${run.runId} in the dataset's run ledger`, windows.map((w) => w.runId));
  const snaps = (await trino.snapshots(GOLD.catalog, GOLD.schema, GOLD.table)).slice(snapshotsBefore);
  const inFirst = snaps.filter((s) => within(Date.parse(s.committed_at), first));
  check(inFirst.length === 1, 'trino', `exactly one snapshot committed inside run ${run.runId}`, inFirst.length);
  const orphans = snaps.filter((s) => !windows.some((w) => within(Date.parse(s.committed_at), w)));
  check(orphans.length === 0, 'trino', 'every new snapshot was committed inside some Dagster run of the dataset', orphans.map((s) => s.snapshot_id));
});

// ---------------------------------------------------------------- 4. metric as the viewer
async function compiled(p, viewer) {
  const { data } = await request('metric-compile', 'compile', `${await baseUrl('metricCompile')}/compile`, { method: 'POST', body: { metrics: [p.metric.name], group_by: ['region'], principal: viewer } });
  check(typeof data.sql === 'string', 'metric-compile', 'response has the compiled sql', data);
  return data.sql;
}

J.assertion('b4.1', { hop: "tile query in Trino as V, byte-equal to MetricFlow's compiled SQL", record: 'Trino system.runtime.queries + metric-compile', expectedFail: 'WP-20' }, async () => {
  const { since, p } = await tileV();
  const rows = trino.requireRows((await trino.runtimeQueries({ user: V, sinceMinutes: 30 })).filter((q) => q.created >= trinoTs(since)), `user=${V}`);
  const sql = await compiled(p, V);
  check(rows.some((q) => q.query === sql), 'trino', 'a query with text byte-equal to metric-compile output', { trino: rows[0].query?.slice(0, 200), compiled: sql.slice(0, 200) });
});

/**
 * The rows a viewer ACTUALLY gets from Trino: the exact SQL the viewer's tile ran (Trino's own query
 * log), re-executed in Trino as that viewer, so Trino + OPA apply the row filter. os-ui's response is
 * never read: a row filter done in TypeScript leaves Trino's answer unfiltered and turns this red.
 */
async function trinoRowsAs(viewer, since) {
  const ran = (await trino.runtimeQueries({ user: viewer, sinceMinutes: 30 })).filter((q) => q.created >= trinoTs(since) && q.state === 'FINISHED' && /po_count|gold_po/i.test(q.query));
  check(ran.length > 0, 'trino', `a FINISHED tile query as ${viewer} in system.runtime.queries`, 0);
  return (await trino.query(ran[0].query, { user: viewer, hop: `tile SQL re-run as ${viewer}` })).rows;
}
async function rowFilterDecision(viewer) {
  const ds = await opa.decisions({ sinceMinutes: 30, match: (e) => e.input?.action?.operation === 'GetRowFilters' && e.input?.context?.identity?.user === viewer && e.input?.action?.resource?.table?.tableName === GOLD.table });
  check(ds.length > 0, 'opa', `a GetRowFilters decision for ${viewer} on ${GOLD.table}`, 0);
  return JSON.stringify(ds.at(-1).result);
}

J.assertion('b4.2', { hop: 'V gets only DE rows, W only FR rows, from Trino with the OPA row filter', record: 'Trino re-execution of each viewer\'s logged tile SQL + OPA GetRowFilters decisions', expectedFail: 'WP-35' }, async () => {
  const { since: sv } = await tileV();
  const { since: sw } = await tileW();
  const regions = (rows) => [...new Set(rows.map((x) => x.region))].sort();
  const rv = await trinoRowsAs(V, sv);
  const rw = await trinoRowsAs(W, sw);
  check(rv.length > 0 && JSON.stringify(regions(rv)) === '["DE"]', 'trino', `Trino returns only region DE to ${V}`, regions(rv));
  check(rw.length > 0 && JSON.stringify(regions(rw)) === '["FR"]', 'trino', `Trino returns only region FR to ${W}`, regions(rw));
  const fv = await rowFilterDecision(V);
  const fw = await rowFilterDecision(W);
  check(/region/.test(fv) && /'DE'/.test(fv) && !/'FR'/.test(fv), 'opa', `row-filter expression for ${V} is region = 'DE'`, fv);
  check(/region/.test(fw) && /'FR'/.test(fw) && !/'DE'/.test(fw), 'opa', `row-filter expression for ${W} is region = 'FR'`, fw);
});

// ---------------------------------------------------------------- negative twins
const LAUNCH = `mutation L($p: ExecutionParams!) { launchRun(executionParams: $p) { __typename ... on LaunchRunSuccess { run { runId } } ... on PythonError { message } ... on RunConfigValidationInvalid { errors { message } } } }`;
let principalTag = U;
J.twin('b-twin-1', { disables: 'os/principal tag tampered (W instead of the owner)', record: 'Dagster run status + Trino system.runtime.queries', expectedFail: 'WP-15', redReasonMust: /^run FAILURE; 0 Trino queries as w-viewer-fr$/ }, {
  check: async () => {
    const { p, run } = await firstRun();
    const since = isoNow();
    const selector = { repositoryLocationName: run.tagMap['dagster/repository_location'] ?? 'sovereign', repositoryName: run.tagMap['dagster/repository'] ?? '__repository__', jobName: run.jobName };
    const tags = [{ key: 'os/principal', value: principalTag }, { key: 'os/run_grant', value: run.tagMap['os/run_grant'] }, { key: 'os/dataset', value: p.ds.id }];
    const d = await dagster.gql(LAUNCH, { p: { selector, executionMetadata: { tags } } }, 'launchRun');
    check(d.launchRun.__typename === 'LaunchRunSuccess', 'dagster', 'launchRun accepted', d.launchRun);
    const done = await dagster.waitForRun(d.launchRun.run.runId);
    const q = (await trino.runtimeQueries({ user: principalTag, sinceMinutes: 15 })).filter((x) => x.created >= trinoTs(since));
    if (done.status !== 'SUCCESS') {
      // The design's red: FAILURE *and* not a single Trino query as the tampered principal.
      throw new HopError({ component: 'dagster', hop: 'tampered run', reason: q.length === 0 ? `run FAILURE; 0 Trino queries as ${principalTag}` : `run FAILURE but ${q.length} Trino queries ran as ${principalTag}` });
    }
    check(q.length > 0, 'trino', `queries ran as ${principalTag}`, q.length);
  },
  disable: async () => { principalTag = W; },
  restore: async () => { principalTag = U; },
});

let preHook = '';
// The receive validator's refusal (10 R4 defence in depth): git reports a declined pre-receive hook,
// and the hook's own message names the forbidden statement. A non-fast-forward `! [rejected]` or any
// other refusal is the WRONG reason.
const RECEIVE_REFUSAL = /pre-receive hook declined/i;
const RECEIVE_MESSAGE = /remote:.*session authorization/i;
J.twin('b-twin-2', { disables: 'model pushed with a SET SESSION AUTHORIZATION pre-hook', record: 'git receive (os-repos) output', expectedFail: 'WP-14', redReasonMust: /^RECEIVE-VALIDATOR-REFUSED session authorization$/ }, {
  check: async () => {
    const dir = await git.clone(DOMAIN);
    const cfg = preHook ? `{{ config(pre_hook="${preHook}") }}\n` : '';
    await mkdir(`${dir}/models/personal/${U}`, { recursive: true });
    await writeFile(`${dir}/models/personal/${U}/e2e_probe_${Date.now()}.sql`, `${cfg}select 1 as one\n`);
    await git.git(['add', '.'], dir);
    await git.git(['-c', `user.name=${U}`, '-c', `user.email=${U}@e2e.local`, 'commit', '-qm', 'e2e probe model'], dir);
    try {
      await git.git(['push', 'origin', 'HEAD'], dir);
    } catch (err) {
      const out = err.detail ?? err.reason ?? '';
      if (RECEIVE_REFUSAL.test(out) && RECEIVE_MESSAGE.test(out)) throw new HopError({ component: 'git', hop: 'receive', reason: 'RECEIVE-VALIDATOR-REFUSED session authorization' });
      throw new HopError({ component: 'git', hop: 'push', reason: `push refused for another reason: ${out.slice(0, 300)}` });
    }
  },
  disable: async () => { preHook = "SET SESSION AUTHORIZATION 'bob'"; },
  restore: async () => { preHook = ''; },
});

const MC_POLICY = process.env.E2E_METRIC_COMPILE_NP ?? 'metric-compile-to-repo-status';
let savedNp;
J.twin('b-twin-3', { disables: 'NetworkPolicy admitting metric-compile to the manifest server removed', record: 'OS tile response', expectedFail: 'WP-20', redReasonMust: /^metric_compile_unavailable: / }, {
  check: async () => {
    const { p } = await firstRun();
    let res;
    // The typed reason the design requires (10 F6): code `metric_compile_unavailable`, never "no data".
    try { res = await callTool(V, 'query_metric', { metricId: p.metric.id, groupBy: ['region'] }); } catch (err) {
      throw new HopError({ component: 'os-ui', hop: 'query_metric', reason: err.detail?.code ? `${err.detail.code}: ${err.detail.reason ?? ''}` : (err.reason ?? err.message) });
    }
    if (!res.rows?.length) throw new HopError({ component: 'os-ui', hop: 'query_metric', reason: `no data (untyped): ${JSON.stringify(res).slice(0, 200)}` });
  },
  disable: async () => {
    savedNp = JSON.parse(await kubectl(['-n', NS, 'get', 'networkpolicy', MC_POLICY, '-o', 'json']));
    await kubectl(['-n', NS, 'delete', 'networkpolicy', MC_POLICY]);
    await kubectl(['-n', NS, 'rollout', 'restart', 'deployment/metric-compile']);
  },
  restore: async () => {
    if (!savedNp) return;
    const { metadata: { name, namespace, labels }, spec } = savedNp;
    await kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name, namespace, labels }, spec }) });
  },
});
