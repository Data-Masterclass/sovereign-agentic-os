/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        metrics
 * FEATURE:    WP-50 (alerts) EJECT + EVALUATION TEST — a committed alert rule is a dbt saved query that
 *             MetricFlow runs, and the OS's evaluator decides the breach from MetricFlow's number
 * USER STORY: As the owner I want my domain's alerts in git as the dbt/MetricFlow code they are, so
 *             `mf query --saved-query <alert>` gives the number with no OS present, and the OS's
 *             scheduled evaluation uses that same MetricFlow query instead of its own SQL compiler.
 * ARCHITECTURE:
 *   - The repo is the REAL generators' output: the data tab's dbt generator (with the alerts model
 *     path) plus the native alert writer, written to disk.
 *   - A PLAIN `trinodb/trino:476` (the chart's tag) with an in-memory catalog holds the gold table.
 *   - EJECT: with `os/**` deleted, the chart's Dagster image runs `dbt parse` and the stock
 *     `mf query --saved-query` (dbt-metricflow) against that Trino.
 *   - EVALUATION: the image's own evaluator (`os_alerts.py evaluate`, the code the Dagster alert
 *     job runs) reads the committed file, runs the same `mf query`, and compares with the file's
 *     threshold. PARITY: its value equals today's OS value (`exploreMetric` → the same Trino), and
 *     its breach decision equals the OS's `evaluateAlert` for that value.
 *   - DAGSTER: the image's own alert job (`repo.py` `_alert_job`, what os-ui launches with the owner
 *     as OS_PRINCIPAL) is executed by Dagster (`execute_in_process`) and outputs the same result.
 *   - NEGATIVE TWINS: an alert naming a metric the project lacks fails `dbt parse`; editing the
 *     committed threshold flips the evaluator's decision (it reads git, not the store).
 *   - Runs when WP52_EJECT=1 (CI job `dashboards-eject`, which builds the image); skipped otherwise.
 */
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const skip = process.env.WP52_EJECT === '1' ? false : 'WP52_EJECT not set (needs docker)';
const DAGSTER_IMAGE = process.env.DAGSTER_IMAGE ?? 'ghcr.io/data-masterclass/sovereign-os/dagster:0.3.2';
const TRINO_IMAGE = process.env.TRINO_IMAGE ?? 'trinodb/trino:476';
const WORK = skip ? '' : mkdtempSync(path.join(process.env.WP52_TMP ?? path.join(homedir(), '.cache'), 'wp50-alerts-'));
const NET = `wp50-alerts-${process.pid}`;
const CTR = `wp50-alerts-trino-${process.pid}`;
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
const shOk = (cmd: string, args: string[]) => {
  try {
    return { ok: true, out: sh(cmd, args) };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${x.stdout ?? ''}${x.stderr ?? ''}` };
  }
};

mock.module('@core/infra/governed', {
  namedExports: {
    queryRun: async (sql: string, principal?: string) => {
      // @ts-ignore -- the harness client is plain JS (tests/lakehouse/lib.mjs)
      const { run } = await import('../lakehouse/lib.mjs');
      const r = await run(sql, { user: principal ?? 'eject', source: 'wp50-alerts' });
      return { engine: 'trino', tables: [], columns: r.columns, rows: r.rows.map((row: unknown[]) => row.map((v) => (v === null ? null : String(v)))), rowCount: r.rows.length };
    },
  },
});
mock.module('../../os-ui/tabs/metrics/lib/build/live-clients.ts', { namedExports: { liveMetricsReachable: async () => true } });

const { generateProject } = await import('@tabs/data/lib/dbt/generate');
const { viewName } = await import('@tabs/data/lib/index');
const { builtLayerFqn } = await import('@tabs/data/lib/store-fqn');
const { viewerToken } = await import('@tabs/metrics/lib/fixtures');
const { exploreMetric } = await import('@tabs/metrics/lib/build/explore-server');
const { evaluateAlert } = await import('@tabs/metrics/lib/alerts');
const { generateAlertFiles, dbtMetricsByMember } = await import('@tabs/metrics/lib/git/alerts-native');
const { committedDbt } = await import('@tabs/metrics/lib/git/alerts-fixtures');
const { alertsModelPath } = await import('@core/infra/repo-layout');
const { ALERT_RESULT_QUERY } = await import('@tabs/metrics/lib/build/alert-eval-metricflow');
const { ORDERS } = await import('./alerts-fixture-dataset.ts');

const V = viewName(ORDERS);
const RULES = [
  { id: 'rev_low', member: `${V}.revenue`, comparator: 'lt' as const, threshold: 100, notify: ['in_app' as const], owner: 'amir', domain: 'sales', createdAt: '2026-11-20T10:00:00.000Z' },
  { id: 'orders_high', member: `${V}.orders`, comparator: 'gte' as const, threshold: 10, notify: ['in_app' as const], owner: 'amir', domain: 'sales', createdAt: '2026-11-20T10:00:00.000Z' },
];
const REPO = () => path.join(WORK, 'repo');

before(async () => {
  if (skip) return;
  const repo = new Map(generateProject('sales', { domain: 'sales', datasets: [{ dataset: ORDERS, artifacts: {} }], catalogs: {} }, { alertsModelPath: alertsModelPath('v1') }));
  // The unit tests' literal fixture names the same metrics the real generator commits.
  assert.deepEqual([...dbtMetricsByMember(repo)], [...dbtMetricsByMember(committedDbt())]);
  const { files, pending } = generateAlertFiles('sales', RULES, repo);
  assert.deepEqual(pending, []);
  for (const [p, c] of files) repo.set(p, c);
  for (const [p, c] of repo) {
    if (p.startsWith('os/')) continue; // the OS layer is deleted before any tool runs
    mkdirSync(path.dirname(path.join(REPO(), p)), { recursive: true });
    writeFileSync(path.join(REPO(), p), c);
  }
  mkdirSync(path.join(WORK, 'trino'), { recursive: true });
  writeFileSync(path.join(WORK, 'trino/iceberg.properties'), 'connector.name=memory\n');
  execFileSync('chmod', ['-R', 'a+rwX', WORK]);
  sh('docker', ['network', 'create', NET]);
  sh('docker', ['run', '-d', '--name', CTR, '--network', NET, '-p', '127.0.0.1::8080', '-v', `${path.join(WORK, 'trino/iceberg.properties')}:/etc/trino/catalog/iceberg.properties:ro`, TRINO_IMAGE]);
  process.env.LH_TRINO_URL = `http://127.0.0.1:${sh('docker', ['port', CTR, '8080/tcp']).trim().split(':').pop()}`;
  for (let i = 0; i < 120 && !shOk('docker', ['exec', CTR, 'trino', '--execute', 'SELECT 1']).ok; i++) await new Promise((r) => setTimeout(r, 2000));
  const fqn = builtLayerFqn(ORDERS, { id: 'amir', domains: ['sales'] }, 'gold')!.fqn;
  const [cat, schema] = fqn.split('.');
  sh('docker', ['exec', CTR, 'trino', '--execute', `CREATE SCHEMA ${cat}.${schema}`]);
  sh('docker', ['exec', CTR, 'trino', '--execute', `CREATE TABLE ${fqn} (order_id integer, order_date date, region varchar, net_amount double)`]);
  sh('docker', ['exec', CTR, 'trino', '--execute', `INSERT INTO ${fqn} VALUES (1, DATE '2026-09-03', 'eu', 10.5), (2, DATE '2026-09-20', 'us', 20.0), (3, DATE '2026-10-02', 'eu', 1.5), (4, DATE '2026-10-09', 'apac', 4.0)`]);
});

after(() => {
  if (skip) return;
  shOk('docker', ['rm', '-f', CTR]);
  shOk('docker', ['network', 'rm', NET]);
  shOk('docker', ['run', '--rm', '-u', '0', '-v', `${WORK}:/w`, TRINO_IMAGE, 'chmod', '-R', 'a+rwX', '/w']);
  if (WORK) rmSync(WORK, { recursive: true, force: true });
});

/** A container of the chart's Dagster image on the Trino network, the repo mounted at /p. */
const inImage = (dir: string, cmd: string[]) =>
  shOk('docker', ['run', '--rm', '--network', NET, '-v', `${dir}:/p`, '-w', '/p', '-e', 'HOME=/tmp', '-e', 'DBT_PROFILES_DIR=/p', '-e', `TRINO_HOST=${CTR}`, '-e', 'OS_PRINCIPAL=amir', '-e', 'TRINO_USER=dbt-runner', DAGSTER_IMAGE, ...cmd]);

type Evaluated = { id: string; saved_query: string; metric: string; value: number; comparator: string; threshold: number; breached: boolean };
const evaluate = (dir: string, id: string): Evaluated => {
  const r = inImage(dir, ['python3', '/opt/dagster/app/os_alerts.py', 'evaluate', '--repo', '/p', '--alert', id]);
  assert.ok(r.ok, `os_alerts evaluate failed:\n${r.out.slice(-3000)}`);
  return JSON.parse(r.out.trim().split('\n').pop()!) as Evaluated;
};

test('EJECT: with os/ deleted, dbt parse accepts the alerts and stock `mf query --saved-query` returns the number', { skip, timeout: 600_000 }, () => {
  const parse = inImage(REPO(), ['dbt', 'parse', '--no-partial-parse']);
  assert.ok(parse.ok, `dbt parse failed:\n${parse.out.slice(-3000)}`);
  const m = JSON.parse(readFileSync(path.join(REPO(), 'target/manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(m.saved_queries).sort(), ['saved_query.sales.orders_high', 'saved_query.sales.rev_low']);
  assert.deepEqual(m.saved_queries['saved_query.sales.rev_low'].config.meta.os_alert, { id: 'rev_low', comparator: 'lt', threshold: 100, owner: m.saved_queries['saved_query.sales.rev_low'].config.meta.os_alert.owner, notify: ['in_app'] });
  const q = inImage(REPO(), ['mf', 'query', '--saved-query', 'rev_low', '--csv', '/p/rev_low.csv']);
  assert.ok(q.ok, `mf query failed:\n${q.out.slice(-3000)}`);
  const csv = readFileSync(path.join(REPO(), 'rev_low.csv'), 'utf8').trim().split('\n');
  assert.equal(csv[0].trim(), 'revenue');
  assert.equal(Number(csv[1]), 36);
});

test('EVALUATION: the image evaluator decides from MetricFlow; value and breach equal the OS today', { skip, timeout: 600_000 }, async () => {
  for (const rule of RULES) {
    const e = evaluate(REPO(), rule.id);
    const [dsId, measureName] = [ORDERS, ORDERS.measures!.find((x) => rule.member.endsWith(`.${x.name}`))!];
    const today = await exploreMetric(dsId, measureName, viewerToken(), {});
    const todayValue = today.rows.reduce((s, row) => s + Number(row[today.member] ?? 0), 0);
    assert.equal(e.value, todayValue, `${rule.id}: MetricFlow ${e.value} vs today ${todayValue}`);
    assert.equal(e.breached, evaluateAlert(rule, e.value).breached, `${rule.id}: breach decision`);
    console.log(`[wp50-alerts] ${rule.id}: mf ${e.saved_query} = ${e.value} (today ${todayValue}) ${e.comparator} ${e.threshold} → breached=${e.breached}`);
  }
});

test('NEGATIVE TWINS: an unknown metric fails dbt parse; an edited committed threshold flips the decision', { skip, timeout: 600_000 }, () => {
  const twin = path.join(WORK, 'twin');
  cpSync(REPO(), twin, { recursive: true });
  rmSync(path.join(twin, 'target'), { recursive: true, force: true });
  const f = path.join(twin, 'metrics/alerts/rev_low.yml');
  const original = readFileSync(f, 'utf8');
  writeFileSync(f, original.replace(/threshold: 100\n/, 'threshold: 10\n'));
  assert.equal(evaluate(twin, 'rev_low').breached, false, '36 < 10 is false: the evaluator read the edited file');
  writeFileSync(f, original.replace(/- revenue\n/, '- no_such_metric\n'));
  const parse = inImage(twin, ['dbt', 'parse', '--no-partial-parse']);
  assert.equal(parse.ok, false, 'dbt must refuse an alert on a metric the project lacks');
  assert.match(parse.out, /no_such_metric/);
});

test('DAGSTER: the image\'s alert job, run by Dagster as the owner, outputs the MetricFlow result', { skip, timeout: 600_000 }, () => {
  const py = [
    'import json, os_projects as osp, repo',
    "p = osp.Project(domain='sales', path='/p', sha='a' * 40, manifest='/p/target/manifest.json')",
    "a = [x for x in __import__('os_alerts').load_alerts('/p') if x['id'] == 'rev_low'][0]",
    "j = repo._alert_job(p, 'sales', a, osp.pinned_one('sales', 'a' * 40))",
    'r = j.execute_in_process(raise_on_error=False)',
    "outs = [e for e in r.all_events if e.event_type_value == 'STEP_OUTPUT']",
    "meta = {k: v.value for k, v in outs[0].event_specific_data.metadata.items()} if outs else {}",
    "print(json.dumps({'job': j.name, 'success': r.success, 'tags': j.tags, 'out': r.output_for_node(j.name + '_op') if r.success else None, 'meta': meta}))",
  ].join('\n');
  const r = shOk('docker', ['run', '--rm', '--network', NET, '-v', `${REPO()}:/p`, '-w', '/opt/dagster/app', '-e', 'HOME=/tmp', '-e', 'REPO_SYNC_CHECKOUT=/tmp/none', '-e', 'DBT_PROFILES_DIR=/p', '-e', `TRINO_HOST=${CTR}`, '-e', 'OS_PRINCIPAL=amir', '-e', 'TRINO_USER=dbt-runner', DAGSTER_IMAGE, 'python3', '-c', py]);
  assert.ok(r.ok, r.out.slice(-3000));
  const out = JSON.parse(r.out.trim().split('\n').pop()!) as { job: string; success: boolean; tags: Record<string, string>; out: Evaluated & { status: string }; meta: Record<string, unknown> };
  assert.equal(out.job, 'sales__alert_rev_low');
  assert.equal(out.success, true);
  assert.equal(out.tags['os/alert'], 'rev_low');
  assert.equal(out.tags['os/principal'], undefined, 'no principal of its own: os-ui sets the owner per launch');
  assert.equal(out.out.status, 'ok');
  assert.equal(out.out.value, 36);
  assert.equal(out.out.breached, true);
  assert.deepEqual(out.meta.os_alert_result, out.out, 'the step output carries the os_alert_result metadata os-ui reads');
});

test('DAGSTER GRAPHQL: the query os-ui reads the result with is valid against the image\'s Dagster schema (and a typo is not)', { skip, timeout: 300_000 }, () => {
  const py = 'import sys\nfrom dagster_graphql.schema import create_schema\nfrom graphql import parse, validate\ns = create_schema()\nq = sys.argv[1]\nprint(len(validate(s.graphql_schema, parse(q))))';
  const ok = sh('docker', ['run', '--rm', DAGSTER_IMAGE, 'python3', '-c', py, ALERT_RESULT_QUERY]).trim();
  assert.equal(ok, '0');
  const typo = sh('docker', ['run', '--rm', DAGSTER_IMAGE, 'python3', '-c', py, ALERT_RESULT_QUERY.replace('jsonString', 'jsonStrin')]).trim();
  assert.notEqual(typo, '0');
});
