/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * run-identity.int.test — WP-15 (design 01 R1–R3, §7.1 tests 3–6; 10 F3/F4) on REAL components:
 *   - the Dagster image built from this checkout: webserver + daemon with the chart's run
 *     coordinator (rendered from values.dagster-run-identity.yaml), the `sovereign` location
 *     (repo.py) over a domain repo the OS committed with its own git store and generator
 *     (`renderProfiles(…, 'ldap')`), runs launched by the daemon (schedule) and by os-ui's own
 *     `launchRun`;
 *   - Trino 476 with TLS + PASSWORD and the chart's OPA sidecar, which downloads the long-polled
 *     os-grants bundle from os-ui's REAL route handlers and reports its revision to os-ui's REAL
 *     status route (tests/dagster/up.sh);
 *   - postgres:17 with the governance schema (run grants);
 *   - a kind API server answering os-ui's TokenReviews for the run pods' projected tokens.
 *
 *  1. A scheduled run under its standing grant acts as its owner: Trino records the owner as the
 *     query user with source dbt-trino, the sidecar logged `ImpersonateUser svc-dagster-runner →
 *     owner` = true, and once the run finished the runner can no longer act as the owner.
 *  2. Parity: per owner, the rows a run writes equal the rows that owner reads interactively
 *     today (legacy path), including the PII mask and the cross-domain row filter.
 *  3. Unauthorised launches fail BEFORE any Trino query: tampered principal, wrong commit, expired
 *     grant, no grant, revoked grant, an owner who lost access, a grant not yet in Trino's OPA
 *     (negative twin of the propagation wait).
 *  4. The start route refuses a token from another ServiceAccount, and no token.
 *  5. Kind binding through the bundle: svc-os-worker cannot use an active Dagster grant; the
 *     activation window (`active_until`) closes in OPA by itself.
 *  6. One data run at a time (QueuedRunCoordinator, max_concurrent_runs 1): a second launch waits.
 *
 * Run: bash tests/dagster/up.sh && cd os-ui && OS_PG_TEST_URL=… node --experimental-test-module-mocks \
 *   --import ./scripts/test-setup.mjs --test ../tests/dagster/run-identity.int.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROJECT = (process.env.LH_PROJECT ??= 'soa-wp15');
process.env.LH_TRINO_PORT ??= '28080';
process.env.LH_TRINO_TLS_PORT ??= '28443';
process.env.LH_OPA_PORT ??= '28181';
const stateFile = join(process.env.TMPDIR ?? tmpdir(), `${PROJECT}.work`);
if (!existsSync(stateFile)) throw new Error(`WP-15 harness not running (no ${stateFile}): run bash tests/dagster/up.sh first`);
const WORK = readFileSync(stateFile, 'utf8').trim();
const H = join(WORK, 'wp15');
const rd = (p: string) => readFileSync(join(H, p), 'utf8').trim();
const IMAGE = rd('image');
const SERVER_PORT = Number(rd('server-port'));
const DAGSTER_PORT = Number(process.env.WP15_DAGSTER_PORT ?? 28300);
const NS = 'agentic-os';
const DOMAIN = 'wp15';
const SRC = 'iceberg.wp15_src.orders';
// Each run gets its own repo and checkout, so the harness can be re-used for several runs.
const RUN = `r${Date.now()}`;

// os-ui's config, before anything imports it.
Object.assign(process.env, {
  OPA_URL: `http://127.0.0.1:${process.env.LH_OPA_PORT}`,
  OS_OPA_BUNDLE_TOKEN: rd('bundle-token'),
  OS_DAGSTER_RUN_GRANTS: '1',
  OS_RUN_GRANT_START_SA: `system:serviceaccount:${NS}:dagster-run`,
  OS_RUN_GRANT_FINISH_SA: `system:serviceaccount:${NS}:dagster-code`,
  OS_RUN_GRANT_OPA_INSTANCES: 'trino-sidecar',
  OS_K8S_SA_DIR: join(H, 'k8s-sa'),
  KUBERNETES_API: rd('k8s-api'),
  DAGSTER_URL: `http://127.0.0.1:${DAGSTER_PORT}`,
  OS_REPOS_DIR: join(H, RUN, 'repos'),
  DATA_PROJECT_GIT: 'true',
});
const { fakeEmptyMirror } = await import('../opa/bundle-it.ts');
await fakeEmptyMirror();
const { freshDatabase } = await import('../../os-ui/core/testing/postgres/it-support.ts');
const { migrateGovernance } = await import('../../os-ui/core/testing/postgres/unwrapped.ts');
const lib = await import('../lakehouse/lib.mjs');
const tls = await import('../lakehouse/tls.mjs');
const pg = createRequire(new URL('../../os-ui/package.json', import.meta.url))('pg') as typeof import('pg');

type Rows = unknown[][];
const pw = (u: string) => (tls.requireSecrets() as { passwords: Record<string, string> }).passwords[u];
const OWNERS = ['alice15', 'carol15', 'bob15'] as const;
// WP-15 review: a domain-lane model (the domain schema, not a personal lane).
const DOMAIN_MODEL = 'orders_domain15';
const lane = (o: string) => `personal_${o}`;

let db: { url: string; drop: () => Promise<void> };
let client: InstanceType<typeof pg.Client>;
let server: Server;
let sha = '';
let keys: Record<string, string[]> = {};
let standingId = '';
/** When the Dagster container started: no run of this test exists before it. */
let dagsterStarted = 0;

// ------------------------------------------------------------------ os-ui's routes on the host --

async function serveOsUi(port: number): Promise<Server> {
  const grants = await import('../../os-ui/app/api/opa/bundles/os-grants.tar.gz/route.ts');
  const status = await import('../../os-ui/app/api/opa/status/route.ts');
  const start = await import('../../os-ui/app/api/runtime/run-grants/[id]/start/route.ts');
  const finish = await import('../../os-ui/app/api/runtime/run-grants/[id]/finish/route.ts');
  const srv = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const request = new Request(`http://localhost${req.url}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    let out: Response;
    const m = /^\/api\/runtime\/run-grants\/([^/]+)\/(start|finish)$/.exec(path);
    if (path === '/api/opa/bundles/os-grants.tar.gz' && req.method === 'GET') out = await grants.GET(request);
    else if (path === '/api/opa/status' && req.method === 'POST') out = await status.POST(request);
    else if (m && req.method === 'POST') out = await (m[2] === 'start' ? start.POST : finish.POST)(request, { params: Promise.resolve({ id: decodeURIComponent(m[1]) }) });
    else out = new Response('not found', { status: 404 });
    res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise<void>((r) => srv.listen(port, '0.0.0.0', () => r()));
  return srv;
}

// -------------------------------------------------------------------------------- helpers --

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms: number, what: string, step = 1000): Promise<T> {
  const end = Date.now() + ms;
  let last: T | undefined;
  for (;;) {
    try {
      last = await fn();
      if (ok(last)) return last;
    } catch {
      /* not yet */
    }
    if (Date.now() > end) throw new Error(`${what}: not reached in ${ms} ms (last ${JSON.stringify(last)?.slice(0, 400)})`);
    await sleep(step);
  }
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${DAGSTER_PORT}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const b = (await r.json()) as { data: T; errors?: unknown };
  if (b.errors) throw new Error(JSON.stringify(b.errors));
  return b.data;
}

type RunState = { status: string; startTime: number | null; endTime: number | null; tags: { key: string; value: string }[] };
const runState = async (id: string) =>
  (await gql<{ runOrError: RunState }>('query($id: ID!){ runOrError(runId: $id){ ... on Run { status startTime endTime tags { key value } } } }', { id })).runOrError;
const finished = (s: RunState | undefined) => !!s && ['SUCCESS', 'FAILURE', 'CANCELED'].includes(s.status);
async function runMessages(id: string): Promise<string> {
  const d = await gql<{ logsForRun: { events: { message?: string }[] } }>(
    'query($id: ID!){ logsForRun(runId: $id, limit: 2000){ ... on EventConnection { events { ... on MessageEvent { message } } } } }', { id });
  return d.logsForRun.events.map((e) => e.message ?? '').join('\n');
}

/** Queries Trino ran with dbt-trino's source since `sinceMs`, by session user. */
async function dbtQueries(sinceMs: number): Promise<{ user: string; query: string }[]> {
  const { rows } = await tls.runTls(
    `SELECT "user", query FROM system.runtime.queries WHERE source LIKE 'dbt-trino%' AND created >= from_unixtime(${Math.floor(sinceMs / 1000) - 1})`,
    { auth: ['svc-os-ui', pw('svc-os-ui')], user: 'svc-os-ui', source: 'lh-observer' },
  ).catch(async () => lib.run(`SELECT "user", query FROM system.runtime.queries WHERE source LIKE 'dbt-trino%' AND created >= from_unixtime(${Math.floor(sinceMs / 1000) - 1})`, { user: 'lh-observer', source: 'lh-observer' }));
  return (rows as Rows).map(([user, query]) => ({ user: String(user), query: String(query) }));
}

const legacy = async (sql: string, user: string): Promise<{ rows?: Rows; error?: string }> => {
  try {
    return { rows: (await lib.run(sql, { user, source: 'os-ui/wp15/query' })).rows as Rows };
  } catch (e) {
    return { error: (e as { errorName?: string }).errorName ?? String(e) };
  }
};

async function launch(tags: Record<string, string>, selection: string[][]): Promise<string> {
  const dg = await import('@core/infra/dagster');
  const r = await dg.launchRun({ domain: DOMAIN, selection, tags: { 'os/domain': DOMAIN, 'os/commit': sha, ...tags } });
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  return r.ok ? r.data.runId : '';
}

async function datasetGrant(owner: string, extra: { commit?: string; selection?: string[][] } = {}): Promise<string> {
  const { issueDatasetGrant } = await import('@core/policy/run-grants');
  const { governanceRuntimePool } = await import('@core/adapters/postgres/pool');
  return issueDatasetGrant(governanceRuntimePool(), {
    principal: owner, domain: DOMAIN, dataset: `ds_${owner}`, commit: extra.commit ?? sha, selection: extra.selection ?? [keys[owner]], issuedBy: owner,
  });
}

const tagsFor = (owner: string, grant: string) => ({ 'os/principal': owner, 'os/dataset': `ds_${owner}`, 'os/run_grant': grant, 'os/user': owner, 'os/action': 'wp15 test' });

/** Launch, wait for the end, return the status, the run's messages and the dbt queries it caused. */
async function launchAndWait(tags: Record<string, string>, selection: string[][]) {
  const t0 = Date.now();
  const id = await launch(tags, selection);
  const s = await until(() => runState(id), finished, 240_000, `run ${id} finished`, 2000);
  await sleep(1500); // Trino's query list is eventually consistent with the client
  return { id, status: s.status, messages: await runMessages(id), queries: await dbtQueries(t0) };
}

// ---------------------------------------------------------------------------------- setup --

before(async () => {
  tls.requireSecrets();
  db = await freshDatabase('wp15_grants');
  await migrateGovernance({ databaseUrl: db.url, direction: 'up' });
  process.env.OS_GOVERNANCE_DATABASE_URL = db.url;
  client = new pg.Client({ connectionString: db.url });
  await client.connect();
  server = await serveOsUi(SERVER_PORT);

  // The chart's seed grant for OPA's status reports (opa.yaml soa.opaSeed), on the push-mode OPA
  // os-ui asks; the sidecar reports there through os-ui's status route.
  // …and the run-grant routes' decisions per ServiceAccount (opa.yaml, with dagsterRunIdentity).
  for (const [p, tools] of [['opa-status-reporter', ['opa_status_report']], [`system:serviceaccount:${NS}:dagster-run`, ['run_grant_start']], [`system:serviceaccount:${NS}:dagster-code`, ['run_grant_finish']]] as const) {
    const put = await fetch(`${process.env.OPA_URL}/v1/data/grants/${encodeURIComponent(p)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tools) });
    assert.equal(put.status, 204, p);
  }
  const { opaInstanceStatuses } = await import('@core/policy/opa-status');
  await until(async () => opaInstanceStatuses(), (s) => s.some((i) => i.instance === 'trino-sidecar' && !!i.bundles['os-grants']?.active_revision), 90_000, 'the sidecar activated os-grants and reported it');

  // People: OS users (who /start checks) and the governance documents the sidecar holds today.
  const users = await import('@tabs/admin/lib/users');
  for (const id of [...OWNERS, 'dora15']) await users.createUser({ id, email: `${id}@wp15.example`, password: 'not-used-wp15', domains: [DOMAIN], role: 'creator' });
  tls.opaPut(`governance/tables/${encodeURIComponent(SRC)}`, { domain: DOMAIN, visibility: 'domain', shared_with: [], shared_with_users: [], sensitive_columns: { email: 'pii' } });
  const principals: Record<string, { domains: string[]; clearances: string[] }> = {
    alice15: { domains: [DOMAIN], clearances: ['pii'] },
    carol15: { domains: [DOMAIN], clearances: [] },
    bob15: { domains: ['other15'], clearances: [] },
    dora15: { domains: [DOMAIN], clearances: [] },
  };
  for (const [id, p] of Object.entries(principals)) tls.opaPut(`governance/principals/${id}`, p);
  await lib.run('CREATE SCHEMA IF NOT EXISTS iceberg.wp15_src', { user: 'lh-setup', source: 'lh-setup' });
  await lib.run(`CREATE OR REPLACE TABLE ${SRC} AS SELECT * FROM (VALUES (1, 'north', 'a@n.example'), (2, 'south', 'b@s.example'), (3, 'east', NULL)) AS t(id, region, email)`, { user: 'lh-setup', source: 'lh-setup' });

  // The domain repo, committed by the OS's own git store; profiles.yml from the OS generator.
  const { renderProfiles, renderMacros } = await import('@tabs/data/lib/dbt/project');
  const { standingGrantId } = await import('@core/policy/run-grant-ids');
  const { commitTree, repoPath } = await import('@core/infra/git-store');
  standingId = standingGrantId(DOMAIN, 'ds_alice15', 'alice15', 'orders_alice15');
  const files = new Map<string, string>([
    ['dbt_project.yml', 'name: wp15\nversion: "1.0.0"\nconfig-version: 2\nprofile: sovereign\nmodel-paths: [models]\nmacro-paths: [macros]\nmodels:\n  wp15:\n    +materialized: table\n    +on_table_exists: replace\n'],
    ['profiles.yml', renderProfiles(DOMAIN, 'ldap')],
    ...renderMacros(),
    ...OWNERS.map((o): [string, string] => [`models/orders_${o}.sql`, `{{ config(schema='${lane(o)}') }}\nselect id, region, email from ${SRC}\n`]),
    [`models/${DOMAIN_MODEL}.sql`, `{{ config(schema='${DOMAIN}') }}\nselect id, region from ${SRC}\n`],
    ['os/schedules.yml', `version: 1\nschedules:\n  - dataset: ds_alice15\n    name: orders_alice15\n    select: orders_alice15\n    cron: "* * * * *"\n    timezone: UTC\n    principal: alice15\n    enabled: true\n    run_grant: ${standingId}\n`],
  ]);
  const c = await commitTree(DOMAIN, files, { author: { name: 'alice15', email: 'alice15@wp15.example' }, message: 'wp15 fixture', reposDir: process.env.OS_REPOS_DIR });
  sha = c.sha;
  const { reconcileStandingGrants } = await import('@core/policy/run-grants');
  const { governanceRuntimePool } = await import('@core/adapters/postgres/pool');
  await reconcileStandingGrants(governanceRuntimePool(), DOMAIN, [{ dataset: 'ds_alice15', principal: 'alice15', schedule: 'orders_alice15', enabled: true, job: 'wp15__ds_alice15' }], 'alice15');

  // repo-sync's checkout (<domain>/<sha> + current) and the manifest, parsed in the image.
  const co = join(H, RUN, 'checkout');
  mkdirSync(join(co, DOMAIN), { recursive: true });
  execFileSync('git', ['clone', '-q', repoPath(DOMAIN, { reposDir: process.env.OS_REPOS_DIR }), join(co, DOMAIN, sha)]);
  symlinkSync(sha, join(co, DOMAIN, 'current'));
  execFileSync('chmod', ['-R', 'a+rwX', co]);
  execFileSync('docker', ['run', '--rm', '--network', 'none', '-v', `${co}:/repos-checkout`, '-e', 'HOME=/tmp', IMAGE, 'python3', '/opt/dagster/app/os_projects.py', '--parse', `/repos-checkout/${DOMAIN}/current`], { stdio: 'inherit' });

  // The runner's secrets as the chart mounts them in a run pod (values.dagster-run-identity.yaml).
  const sec = tls.requireSecrets() as { ca: string; passwords: Record<string, string> };
  for (const d of ['pw', 'ca']) mkdirSync(join(H, d), { recursive: true });
  writeFileSync(join(H, 'pw', 'password'), pw('svc-dagster-runner'));
  writeFileSync(join(H, 'ca', 'ca.crt'), sec.ca);
  for (const f of ['pw/password', 'ca/ca.crt', 'tokens/run', 'tokens/code']) chmodSync(join(H, f), 0o644);

  // The daemon's run coordinator exactly as the chart renders it with the overlay.
  const rendered = execFileSync('helm', ['template', 'agentic-os', join(ROOT, 'charts/sovereign-agentic-os'), '-n', NS, '-f', join(ROOT, 'values.dagster-launcher-lockdown.yaml'), '-f', join(ROOT, 'values.dagster-run-identity.yaml'),
    '--set', 'postgres.governance.adminSecretName=wp15-it'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const yaml = createRequire(new URL('../../os-ui/package.json', import.meta.url))('js-yaml') as typeof import('js-yaml');
  const inst = (yaml.loadAll(rendered) as { kind?: string; metadata?: { name?: string }; data?: Record<string, string> }[])
    .find((d) => d?.kind === 'ConfigMap' && d.data?.['dagster.yaml']?.includes('run_coordinator'));
  assert.ok(inst, 'the chart renders the Dagster instance config');
  const rc = (yaml.load(inst!.data!['dagster.yaml']) as { run_coordinator: unknown }).run_coordinator;
  writeFileSync(join(H, 'dagster.yaml'), yaml.dump({ run_coordinator: rc, telemetry: { enabled: false } }));
  writeFileSync(join(H, 'workspace.yaml'), 'load_from:\n  - python_file:\n      relative_path: /opt/dagster/app/repo.py\n      working_directory: /opt/dagster/app\n      location_name: sovereign\n');
  chmodSync(join(H, 'dagster.yaml'), 0o644);

  spawnSync('docker', ['rm', '-f', 'wp15-dagster']);
  dagsterStarted = Date.now();
  execFileSync('docker', ['run', '-d', '--name', 'wp15-dagster', '--network', `${PROJECT}_lh`, '--add-host=host.docker.internal:host-gateway',
    '-p', `127.0.0.1:${DAGSTER_PORT}:3000`,
    '-v', `${co}:/repos-checkout`, '-v', `${join(H, 'pw')}:/var/run/secrets/dagster-runner-trino:ro`, '-v', `${join(H, 'ca')}:/var/run/secrets/trino-ca:ro`,
    '-v', `${join(H, 'tokens')}:/var/run/secrets/os-ui-tokens:ro`, '-v', `${H}:/wp15:ro`,
    '-e', 'HOME=/tmp', '-e', 'DAGSTER_HOME=/tmp/dh', '-e', 'REPO_SYNC_CHECKOUT=/repos-checkout', '-e', 'DBT_SEND_ANONYMOUS_USAGE_STATS=false',
    '-e', 'TRINO_HOST=trino', '-e', 'TRINO_TLS_PORT=8443', '-e', 'TRINO_RUNNER_USER=svc-dagster-runner', '-e', 'TRINO_CATALOG=iceberg',
    '-e', 'TRINO_CA_FILE=/var/run/secrets/trino-ca/ca.crt',
    '-e', 'OS_RUN_TOKEN_FILE=/var/run/secrets/os-ui-tokens/run', '-e', 'OS_CODE_TOKEN_FILE=/var/run/secrets/os-ui-tokens/code',
    '-e', `OS_UI_URL=http://host.docker.internal:${SERVER_PORT}`,
    IMAGE, 'sh', '-c', 'mkdir -p $DAGSTER_HOME && cp /wp15/dagster.yaml $DAGSTER_HOME/ && (dagster-daemon run -w /wp15/workspace.yaml > /tmp/daemon.log 2>&1 &) && exec dagster-webserver -w /wp15/workspace.yaml -h 0.0.0.0 -p 3000']);
  const nodes = await until(
    () => gql<{ assetNodes: { assetKey: { path: string[] } }[] }>('{ assetNodes { assetKey { path } } }'),
    (d) => d.assetNodes.length >= OWNERS.length + 1, 180_000, 'the sovereign location loads the domain', 3000);
  keys.domain = nodes.assetNodes.map((n) => n.assetKey.path).find((p) => p[p.length - 1] === DOMAIN_MODEL)!;
  assert.ok(keys.domain, 'the domain-lane asset');
  for (const o of OWNERS) {
    const k = nodes.assetNodes.map((n) => n.assetKey.path).find((p) => p[p.length - 1] === `orders_${o}`);
    assert.ok(k, `asset for ${o}`);
    keys[o] = k!;
  }
});

after(async () => {
  if (process.env.WP15_KEEP !== '1') spawnSync('docker', ['rm', '-f', 'wp15-dagster']);
  await new Promise<void>((r) => (server ? (server.closeAllConnections(), server.close(() => r())) : r()));
  const { closeGovernancePool } = await import('@core/adapters/postgres/pool');
  await closeGovernancePool();
  await client?.end();
  await db?.drop();
});

// ---------------------------------------------------------------------------------- tests --

const OWNER_SQL = `SELECT id, region, email FROM ${SRC} ORDER BY id`;

test('1. a scheduled run under its standing grant acts as its owner, and only while it runs', async () => {
  const runs = await until(
    () => gql<{ runsOrError: { results: { runId: string; status: string; tags: { key: string; value: string }[] }[] } }>(
      '{ runsOrError(filter: {tags: [{key: "os/schedule", value: "wp15__ds_alice15"}]}) { ... on Runs { results { runId status tags { key value } } } } }'),
    (d) => d.runsOrError.results.some((r) => r.status === 'SUCCESS'), 240_000, 'a scheduled run succeeded', 3000);
  const run = runs.runsOrError.results.find((r) => r.status === 'SUCCESS')!;
  const tag = Object.fromEntries(run.tags.map((t) => [t.key, t.value]));
  assert.equal(tag['os/principal'], 'alice15');
  assert.equal(tag['os/run_grant'], standingId);
  const q = await dbtQueries(dagsterStarted);
  assert.ok(q.some((x) => x.user === 'alice15'), 'Trino ran dbt-trino queries as the owner');
  assert.ok(!q.some((x) => x.user === 'svc-dagster-runner' || x.user === 'dbt-runner'), 'never as a service user');
  const d = tls.sidecarDecisions(new Date(dagsterStarted).toISOString()).filter((x: { input?: { action?: { operation?: string } } }) => x.input?.action?.operation === 'ImpersonateUser');
  assert.ok(d.some((x: { result: boolean; input: { context: { identity: { user: string } }; action: { resource: { user: { user: string } } } } }) =>
    x.result === true && x.input.context.identity.user === 'svc-dagster-runner' && x.input.action.resource.user.user === 'alice15'), 'the sidecar allowed svc-dagster-runner → alice15');
  // Finished ⇒ not active: the run-status sensor (or os-ui's finisher) ended it, and the bundle
  // carried that to the sidecar.
  await until(async () => (await client.query('SELECT active_run_id FROM os_governance.run_grants WHERE id = $1', [standingId])).rows[0].active_run_id, (v) => v === null, 60_000, 'activation ended');
  await until(() => tls.runTls('SELECT current_user', { auth: ['svc-dagster-runner', pw('svc-dagster-runner')], user: 'alice15' }).then(() => 'allowed', (e: { errorName?: string }) => e.errorName ?? 'error'),
    (v) => v === 'PERMISSION_DENIED', 30_000, 'the runner can no longer act as the owner');

  // The owner disables the sync: the commit hook's reconcile revokes the standing grant, and the
  // schedule's next tick (it still fires) is refused before any query.
  const { reconcileStandingGrants } = await import('@core/policy/run-grants');
  const { governanceRuntimePool } = await import('@core/adapters/postgres/pool');
  await reconcileStandingGrants(governanceRuntimePool(), DOMAIN, [{ dataset: 'ds_alice15', principal: 'alice15', schedule: 'orders_alice15', enabled: false, job: 'wp15__ds_alice15' }], 'alice15');
  const tRevoked = Date.now() / 1000;
  const failed = await until(
    () => gql<{ runsOrError: { results: { runId: string; status: string; startTime: number | null }[] } }>(
      '{ runsOrError(filter: {tags: [{key: "os/schedule", value: "wp15__ds_alice15"}]}) { ... on Runs { results { runId status startTime } } } }'),
    (d) => d.runsOrError.results.some((r) => r.status === 'FAILURE' && (r.startTime ?? 0) > tRevoked), 150_000, 'the next scheduled run was refused', 3000);
  const f = failed.runsOrError.results.find((r) => r.status === 'FAILURE' && (r.startTime ?? 0) > tRevoked)!;
  assert.match(await runMessages(f.runId), /unauthorised launch: .*revoked/);
  assert.deepEqual((await dbtQueries(tRevoked * 1000)).filter((x) => x.user === 'alice15'), [], 'the refused scheduled run issued no query');
});

test('2. parity: per owner, the rows a run writes equal what the owner reads today', async () => {
  const summary: Record<string, unknown> = {};
  for (const o of ['carol15', 'bob15', 'alice15']) {
    const r = await launchAndWait(tagsFor(o, await datasetGrant(o)), [keys[o]]);
    assert.equal(r.status, 'SUCCESS', `${o}: ${r.messages.slice(-1500)}`);
    assert.ok(r.queries.length > 0 && r.queries.every((x) => x.user === o), `${o}: every dbt query ran as ${o}`);
    const today = await legacy(OWNER_SQL, o);
    const written = await legacy(`SELECT id, region, email FROM iceberg.${lane(o)}.orders_${o} ORDER BY id`, o);
    assert.deepEqual(written, today, `${o}: the run wrote exactly what ${o} reads`);
    summary[o] = written.rows;
  }
  // Not vacuous: the governance under test really differs per owner.
  assert.deepEqual(summary.alice15, [[1, 'north', 'a@n.example'], [2, 'south', 'b@s.example'], [3, 'east', null]]);
  assert.deepEqual(summary.carol15, [[1, 'north', null], [2, 'south', null], [3, 'east', null]], 'PII masked without the clearance');
  assert.deepEqual(summary.bob15, [], 'cross-domain row filter');
  // For the record: what today's Dagster identity (dbt-trino `method: none` → session user
  // dbt-runner) reads from the same table.
  console.log(`[wp15] parity per owner: ${JSON.stringify(summary)}; today's Dagster session user dbt-runner reads ${JSON.stringify(await legacy(OWNER_SQL, 'dbt-runner'))}`);
});

async function refused(what: string, tags: Record<string, string>, selection: string[][], reason: RegExp, principals: string[]) {
  const r = await launchAndWait(tags, selection);
  assert.equal(r.status, 'FAILURE', `${what}: the run must fail`);
  assert.match(r.messages, /unauthorised launch/, `${what}: failed as an unauthorised launch`);
  assert.match(r.messages, reason, `${what}: with the reason`);
  assert.deepEqual(r.queries.filter((x) => principals.includes(x.user) || x.user.startsWith('svc-')), [], `${what}: no Trino query was issued`);
}

test('3. unauthorised launches fail before any Trino query', async () => {
  await refused('tampered principal', { ...tagsFor('carol15', await datasetGrant('carol15')), 'os/principal': 'alice15' }, [keys.carol15], /another principal/, ['alice15', 'carol15']);
  await refused('wrong commit', tagsFor('carol15', await datasetGrant('carol15', { commit: 'f'.repeat(40) })), [keys.carol15], /another commit/, ['carol15']);
  await refused('wider selection', tagsFor('carol15', await datasetGrant('carol15')), [keys.carol15, keys.alice15], /other assets/, ['carol15', 'alice15']);
  await client.query(
    `INSERT INTO os_governance.run_grants (id, kind, principal_uid, domain, dataset, selection_hash, commit, issued_by, issued_at, expires_at)
     VALUES ('rg_ds_0000000000000000000e0e0e', 'dataset', 'carol15', $1, 'ds_carol15', $2, $3, 'carol15', now() - interval '2 hours', now() - interval '1 hour')`,
    [DOMAIN, (await import('@core/policy/run-grant-ids')).selectionHash([keys.carol15]), sha]);
  await refused('expired grant', tagsFor('carol15', 'rg_ds_0000000000000000000e0e0e'), [keys.carol15], /expired/, ['carol15']);
  const noGrant = tagsFor('carol15', 'x');
  delete (noGrant as Record<string, string>)['os/run_grant'];
  await refused('no grant', noGrant, [keys.carol15], /no run grant/, ['carol15']);
  const g = await datasetGrant('carol15');
  const { revokeRunGrant } = await import('@core/policy/run-grants');
  const { governanceRuntimePool: pool } = await import('@core/adapters/postgres/pool');
  await revokeRunGrant(pool(), g);
  await refused('revoked grant', tagsFor('carol15', g), [keys.carol15], /no run grant|revoked/, ['carol15']);
  // The owner loses access between the grant and the run.
  const dora = await datasetGrant('dora15', { selection: [keys.carol15] });
  const users = await import('@tabs/admin/lib/users');
  await users.archiveUser('dora15');
  await refused('owner lost access', { ...tagsFor('dora15', dora), 'os/dataset': 'ds_dora15' }, [keys.carol15], /owner lost access: dora15 is deactivated/, ['dora15']);
  // Negative twin of the propagation wait: an OPA instance that never reports → no start.
  process.env.OS_RUN_GRANT_OPA_INSTANCES = 'trino-sidecar,never-reports';
  try {
    await refused('grant not in Trino\'s OPA', tagsFor('carol15', await datasetGrant('carol15')), [keys.carol15], /grant_not_propagated/, ['carol15']);
  } finally {
    process.env.OS_RUN_GRANT_OPA_INSTANCES = 'trino-sidecar';
  }
});

test('4. /start refuses a token from another ServiceAccount, and no token', async () => {
  const g = await datasetGrant('carol15');
  const post = (auth?: string) => fetch(`http://127.0.0.1:${SERVER_PORT}/api/runtime/run-grants/${g}/start`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify({ run_id: 'x' }),
  });
  assert.equal((await post()).status, 401);
  assert.equal((await post('not-a-token')).status, 401);
  const code = await post(rd('tokens/code'));
  assert.equal(code.status, 403, 'the code server SA may not start a run');
  assert.equal(((await code.json()) as { error: string }).error, 'forbidden');
  assert.equal((await post(rd('k8s-sa/token'))).status, 401, 'a token for another audience');
});

test('5. through the bundle: svc-os-worker cannot use an active Dagster grant; the window closes itself', async () => {
  const { waitForBundleRevision } = await import('@core/policy/opa-status');
  const g = await datasetGrant('carol15');
  const set = async (until: string) => {
    await client.query(`UPDATE os_governance.run_grants SET active_run_id = 'manual-run', active_until = ${until} WHERE id = $1`, [g]);
    const rev = (await client.query('SELECT rev::text AS rev FROM os_governance.grant_revision WHERE id = 1')).rows[0].rev;
    assert.equal((await waitForBundleRevision('os-grants', rev, ['trino-sidecar'], 10_000)).ok, true);
  };
  const as = (svc: string) => tls.runTls('SELECT current_user', { auth: [svc, pw(svc)], user: 'carol15' }).then((r: { rows: Rows }) => String(r.rows[0][0]), (e: { errorName?: string }) => e.errorName ?? 'error');
  await set("now() + interval '5 minutes'");
  assert.equal(await as('svc-dagster-runner'), 'carol15');
  assert.equal(await as('svc-os-worker'), 'PERMISSION_DENIED', 'kind binding: an agent worker cannot use a Dagster grant');
  await set("now() + interval '3 seconds'");
  await sleep(4000);
  assert.equal(await as('svc-dagster-runner'), 'PERMISSION_DENIED', 'active_until passed: closed in OPA with no OS action');
});

test('6. one data run at a time: a second launch waits in the queue', async () => {
  const a = await launch(tagsFor('alice15', await datasetGrant('alice15')), [keys.alice15]);
  const b = await launch(tagsFor('carol15', await datasetGrant('carol15')), [keys.carol15]);
  const seen = await until(async () => [await runState(a), await runState(b)], ([x, y]) => (x.status === 'STARTED' && y.status === 'QUEUED') || (y.status === 'STARTED' && x.status === 'QUEUED'), 120_000, 'one started while the other queued', 500);
  assert.ok(seen);
  const end = await until(async () => [await runState(a), await runState(b)], (s) => s.every(finished), 300_000, 'both finished', 2000);
  assert.deepEqual(end.map((s) => s.status), ['SUCCESS', 'SUCCESS']);
});

test('7. P1 on real Trino: the runner and the agent worker have no rights of their own, only impersonation', async () => {
  // Ungoverned table the harness user writes (so a denial below is the rule, not a missing table).
  await lib.run('CREATE SCHEMA IF NOT EXISTS iceberg.wp15_free', { user: 'lh-setup', source: 'lh-setup' });
  await lib.run('CREATE OR REPLACE TABLE iceberg.wp15_free.t AS SELECT 42 AS v', { user: 'lh-setup', source: 'lh-setup' });
  assert.deepEqual((await legacy('SELECT v FROM iceberg.wp15_free.t', 'lh-setup')).rows, [[42]], 'twin: the table is there and readable by an ordinary user');
  const self = (svc: string, sql: string) => tls.runTls(sql, { auth: [svc, pw(svc)], source: 'lh-wp15-p1' }).then(() => 'allowed', (e: { errorName?: string }) => e.errorName ?? 'error');
  for (const svc of ['svc-dagster-runner', 'svc-os-worker']) {
    for (const sql of [
      'SELECT 1',
      'SHOW CATALOGS',
      'SHOW SCHEMAS FROM iceberg',
      'SELECT v FROM iceberg.wp15_free.t',
      `SELECT count(*) FROM ${SRC}`,
      'CREATE SCHEMA iceberg.wp15_planted',
      `CREATE TABLE iceberg.wp15_src.planted_${svc.replace(/-/g, '_')} AS SELECT 42 AS v`,
      'DESCRIBE iceberg.wp15_free.t',
    ]) assert.equal(await self(svc, sql), 'PERMISSION_DENIED', `${svc} as itself: ${sql}`);
  }
  assert.equal((await legacy("SELECT count(*) FROM iceberg.information_schema.tables WHERE table_name LIKE 'planted%'", 'lh-setup')).rows?.[0]?.[0], 0, 'nothing was planted');
});

test('8. a domain-lane build acts as the person who launched it; a domain self-principal is refused', async () => {
  const { issueDatasetGrant } = await import('@core/policy/run-grants');
  const { governanceRuntimePool } = await import('@core/adapters/postgres/pool');
  const grant = (principal: string) => issueDatasetGrant(governanceRuntimePool(), { principal, domain: DOMAIN, dataset: 'ds_domain15', commit: sha, selection: [keys.domain], issuedBy: 'carol15' });
  const tags = (principal: string, g: string) => ({ 'os/principal': principal, 'os/dataset': 'ds_domain15', 'os/run_grant': g, 'os/user': 'carol15', 'os/action': 'transform silver' });
  const ok = await launchAndWait(tags('carol15', await grant('carol15')), [keys.domain]);
  assert.equal(ok.status, 'SUCCESS', ok.messages.slice(-1500));
  assert.ok(ok.queries.length > 0 && ok.queries.every((x) => x.user === 'carol15'), 'every dbt query ran as the launching user');
  assert.deepEqual((await legacy(`SELECT id, region FROM iceberg.${DOMAIN}.${DOMAIN_MODEL} ORDER BY id`, 'carol15')).rows, [[1, 'north'], [2, 'south'], [3, 'east']]);
  // Twin: today's domain self-principal as the run's principal is not a person — refused at start.
  await refused('domain self-principal', tags(DOMAIN, await grant(DOMAIN)), [keys.domain], /owner lost access: wp15 is not an OS user/, [DOMAIN]);
});
