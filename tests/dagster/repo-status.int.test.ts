/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * repo-status.int.test — WP-16 (design 01 M2, §7.1 tests 2, 9, 9b; 10 F6, F10) on REAL components:
 * repo-sync.sh and repo.py from the Dagster image built from this checkout, a domain repo the OS
 * committed with its own git store and generator, dagster-webserver from the same image, and
 * postgres:17 with the governance schema. Nothing is faked: dbt's own `dbt parse` decides, Dagster's
 * own GraphQL reports health.
 *
 *  1. The feed: repo-sync parses the good head once, points `current` at it and serves dbt's own
 *     manifest.json + semantic_manifest.json for that commit and its verdict; os-ui reads them.
 *  2. The single gate (test 2): a commit dbt refuses is parsed ONCE across several passes; its
 *     verdict carries dbt's error text; Dagster keeps the previous commit (`current` unchanged).
 *  3. commit_checks (10 F10): os-ui copies the verdicts — passed for the good sha, failed with
 *     dbt's text for the refused one — into os_governance.commit_checks.
 *  4. Refusals: a wrong bearer is 401, a path outside the feed and a sha never parsed are not served.
 *  5. Source tests are asset checks (test 9b): a dbt source test becomes a check on the source asset
 *     in the `sovereign` location (repo.py's translator).
 *  6. Asset health (test 9): after a failing asset check Dagster reports the check FAILED and os-ui
 *     shows red; a passing one green; an unknown key is null. (Dagster OSS 1.13 serves no
 *     `assetHealth` rollup — `dagster_asset_health_queries_supported()` is False outside Dagster+.)
 *
 * Run (from os-ui/): OS_PG_TEST_URL=… WP16_DAGSTER_IMAGE=sovereign-os/dagster:wp16 \
 *   node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test ../tests/dagster/repo-status.int.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const IMAGE = process.env.WP16_DAGSTER_IMAGE ?? 'sovereign-os/dagster:ci';
const FEED_PORT = Number(process.env.WP16_FEED_PORT ?? 28389);
const DG_PORT = Number(process.env.WP16_DAGSTER_PORT ?? 28390);
const TOKEN = `wp16-${Math.random().toString(36).slice(2)}`;
const DOMAIN = 'wp16';
// Under $HOME: a VM-backed docker (colima) shares the home directory.
const W = mkdtempSync(join(process.env.WP16_WORK_PARENT ?? join(homedir(), '.cache'), 'wp16-'));
const REPOS = join(W, 'repos');
mkdirSync(REPOS, { recursive: true });
Object.assign(process.env, {
  OS_REPOS_DIR: REPOS,
  DAGSTER_REPO_STATUS_URL: `http://127.0.0.1:${FEED_PORT}`,
  AGENT_RUNTIME_TOKEN: TOKEN,
  DAGSTER_URL: `http://127.0.0.1:${DG_PORT}`,
});
const { freshDatabase } = await import('../../os-ui/core/testing/postgres/it-support.ts');
const { migrateGovernance } = await import('../../os-ui/core/testing/postgres/unwrapped.ts');
const feed = await import('@core/adapters/dagster/graphql-read');
const pg = createRequire(new URL('../../os-ui/package.json', import.meta.url))('pg') as typeof import('pg');

const SYNC = 'wp16-repo-sync';
const DG = 'wp16-dagster';
let db: { url: string; drop: () => Promise<void> };
let pool: InstanceType<typeof pg.Pool>;
let good = '';
let bad = '';

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
const logs = (name: string) => {
  const r = spawnSync('docker', ['logs', name], { encoding: 'utf8', maxBuffer: 32 << 20 });
  return `${r.stdout}\n${r.stderr}`;
};

async function commit(files: Map<string, string>, message: string): Promise<string> {
  const { commitTree } = await import('@core/infra/git-store');
  return (await commitTree(DOMAIN, files, { author: { name: 'ann', email: 'ann@wp16.example' }, message, reposDir: REPOS })).sha;
}

async function project(model: string): Promise<Map<string, string>> {
  const { renderProfiles, renderMacros } = await import('@tabs/data/lib/dbt/project');
  return new Map<string, string>([
    ['dbt_project.yml', 'name: wp16\nversion: "1.0.0"\nconfig-version: 2\nprofile: sovereign\nmodel-paths: [models]\nmacro-paths: [macros]\n'],
    ['profiles.yml', renderProfiles(DOMAIN)],
    ...renderMacros(),
    ['models/sources.yml', 'version: 2\nsources:\n  - name: raw\n    schema: wp16_raw\n    tables:\n      - name: orders\n        columns:\n          - name: id\n            data_tests: [not_null]\n'],
    ['models/orders.sql', model],
  ]);
}

before(async () => {
  db = await freshDatabase('wp16_checks');
  await migrateGovernance({ databaseUrl: db.url, direction: 'up' });
  pool = new pg.Pool({ connectionString: db.url });
  good = await commit(await project("select id from {{ source('raw', 'orders') }}\n"), 'wp16 good');
  const { repoPath } = await import('@core/infra/git-store');
  const origin = repoPath(DOMAIN, { reposDir: REPOS });
  execFileSync('chmod', ['-R', 'a+rwX', REPOS]);
  const co = join(W, 'checkout');
  mkdirSync(co, { recursive: true });
  chmodSync(co, 0o777);
  spawnSync('docker', ['rm', '-f', SYNC, DG]);
  // repo-sync exactly as the chart runs the sidecar, but reading the repo from a mounted path
  // (git clone takes a path like a git:// URL) and bound to 0.0.0.0 so the host can reach it.
  execFileSync('docker', ['run', '-d', '--name', SYNC, '-p', `127.0.0.1:${FEED_PORT}:8089`,
    '-v', `${origin}:/origin/${DOMAIN}.git:ro`, '-v', `${co}:/repos-checkout`,
    // The mounted bare repo belongs to the host user, not the container's: git's ownership check
    // would refuse it on Linux (in the cluster the repo comes over git:// and this does not apply).
    '-e', 'GIT_CONFIG_COUNT=1', '-e', 'GIT_CONFIG_KEY_0=safe.directory', '-e', 'GIT_CONFIG_VALUE_0=*',
    '-e', 'HOME=/tmp', '-e', 'REPO_SYNC_ENABLED=true', '-e', `REPO_SYNC_DOMAINS=${DOMAIN}`, '-e', 'REPO_SYNC_INDEX_URL=',
    '-e', 'REPO_SYNC_GIT_BASE=/origin', '-e', 'REPO_SYNC_CHECKOUT=/repos-checkout', '-e', 'REPO_SYNC_INTERVAL=2',
    '-e', 'REPO_SYNC_STATUS_PORT=8089', '-e', 'POD_IP=0.0.0.0', '-e', 'POD_NAME=wp16-dagster-user-deployments-sovereign-0',
    '-e', `REPO_SYNC_STATUS_TOKEN=${TOKEN}`, '-e', 'DAGSTER_RELOAD_LOCATION=',
    IMAGE, '/bin/sh', '/opt/dagster/app/repo-sync.sh']);
});

after(async () => {
  if (process.env.WP16_KEEP !== '1') spawnSync('docker', ['rm', '-f', SYNC, DG]);
  await pool?.end();
  await db?.drop();
});

test('1. the feed serves dbt\'s own verdict and manifests for the commit Dagster runs', async () => {
  const st = await until(() => feed.repoStatus(), (r) => r.ok && r.value[DOMAIN]?.current === good, 180_000, 'repo-sync parsed the good head');
  assert.ok(st.ok);
  assert.equal(st.value[DOMAIN].error, null);
  const v = await feed.repoVerdict(DOMAIN, good);
  assert.ok(v.ok && v.value?.ok === true, 'the passed verdict');
  const m = await feed.repoManifest(DOMAIN, good, 'manifest.json');
  assert.ok(m.ok && m.value, 'dbt\'s manifest.json');
  const nodes = Object.keys((m.value as { nodes: Record<string, unknown> }).nodes);
  assert.ok(nodes.includes('model.wp16.orders'), `the manifest is this commit's project (${nodes.join(', ')})`);
  assert.ok(Object.keys((m.value as { sources: Record<string, unknown> }).sources).includes('source.wp16.raw.orders'));
  const sm = await feed.repoManifest(DOMAIN, good, 'semantic_manifest.json');
  assert.ok(sm.ok && sm.value && 'semantic_models' in sm.value, 'dbt\'s semantic_manifest.json (what metric-compile reads)');
});

test('2. a commit dbt refuses is parsed once, its verdict is dbt\'s text, Dagster keeps the last good one', async () => {
  bad = await commit(await project("select id from {{ source('raw', 'orders') \n"), 'wp16 broken jinja');
  execFileSync('chmod', ['-R', 'a+rwX', REPOS]);
  const st = await until(() => feed.repoStatus(), (r) => r.ok && r.value[DOMAIN]?.head === bad && !!r.value[DOMAIN]?.error, 120_000, 'repo-sync refused the bad head');
  assert.ok(st.ok);
  assert.equal(st.value[DOMAIN].current, good, 'Dagster keeps the last good commit');
  assert.match(st.value[DOMAIN].error ?? '', /dbt parse failed/);
  await sleep(8000); // >= 3 more passes at REPO_SYNC_INTERVAL=2
  const parsed = logs(SYNC).split('\n').filter((l) => l.includes(`parsing ${bad}`));
  assert.equal(parsed.length, 1, `the refused sha is parsed exactly once across passes (${parsed.length})`);
  const v = await feed.repoVerdict(DOMAIN, bad);
  assert.ok(v.ok && v.value && v.value.ok === false);
  assert.match(v.value!.error ?? '', /Compilation Error|unexpected|end of template|Syntax/i, 'dbt\'s own error text');
  const m = await feed.repoManifest(DOMAIN, bad, 'manifest.json');
  assert.ok(m.ok && m.value === null, 'a refused commit has no manifest');
});

test('3. os-ui copies the verdicts into commit_checks', async () => {
  // The good head was the head once (test 1); copy that state too by asking for it directly.
  const r = await (await import('@core/adapters/dagster/commit-checks')).copyDbtParseVerdicts(pool as unknown as import('pg').Pool);
  assert.ok(r.ok, r.ok ? '' : r.detail);
  assert.deepEqual(r.value, [{ domain: DOMAIN, sha: bad, status: 'failed' }]);
  const row = (await pool.query('SELECT status, details FROM os_governance.commit_checks WHERE domain = $1 AND sha = $2 AND check_name = $3', [DOMAIN, bad, 'dbt-parse'])).rows[0];
  assert.equal(row.status, 'failed');
  assert.match(row.details.error, /dbt parse|Compilation|unexpected|Syntax/i);
  assert.equal(row.details.current, good);
  // A fix lands: the new head parses and is copied as passed.
  const fixed = await commit(await project("select id, 1 as one from {{ source('raw', 'orders') }}\n"), 'wp16 fixed');
  execFileSync('chmod', ['-R', 'a+rwX', REPOS]);
  await until(() => feed.repoStatus(), (s) => s.ok && s.value[DOMAIN]?.current === fixed, 120_000, 'the fix parsed');
  const r2 = await (await import('@core/adapters/dagster/commit-checks')).copyDbtParseVerdicts(pool as unknown as import('pg').Pool);
  assert.ok(r2.ok && r2.value.some((x) => x.sha === fixed && x.status === 'passed'));
  const all = (await pool.query("SELECT sha, status FROM os_governance.commit_checks WHERE check_name = 'dbt-parse' ORDER BY checked_at")).rows;
  assert.deepEqual(all.map((x: { sha: string; status: string }) => [x.sha, x.status]), [[bad, 'failed'], [fixed, 'passed']]);
});

test('4. refusals: a wrong bearer, a path outside the feed, a sha never parsed', async () => {
  const wrong = await feed.repoStatus({ token: 'not-the-token' });
  assert.equal(wrong.ok ? '' : wrong.reason, 'unauthorized');
  for (const p of ['/manifests/wp16/../../etc/passwd', `/manifests/${DOMAIN}/${good}/profiles.yml`, '/.verdicts', `/${DOMAIN}/current/profiles.yml`]) {
    const res = await fetch(`http://127.0.0.1:${FEED_PORT}${p}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 404, p);
  }
  const never = await feed.repoVerdict(DOMAIN, 'e'.repeat(40));
  assert.ok(never.ok && never.value === null);
});

test('5. a dbt source test is an asset check on the source asset (repo.py translator)', () => {
  const out = execFileSync('docker', ['exec', '-e', 'REPO_SYNC_CHECKOUT=/repos-checkout', '-w', '/opt/dagster/app', SYNC, 'python3', '-c', [
    'import logging, repo',
    'keys = sorted("/".join(k.asset_key.path) + ":" + k.name for k in repo.defs.get_repository_def().asset_graph.asset_check_keys)',
    'print("\\n".join(keys))',
  ].join('\n')], { encoding: 'utf8' });
  const checks = out.trim().split('\n');
  assert.ok(checks.some((c) => /^wp16\/raw\/orders:.*not_null/.test(c) || /raw\/orders:.*not_null/.test(c)), `a check on the source asset: ${checks.join(' | ')}`);
});

test('6. asset health from Dagster: a failed check is red, a passing one green, unknown null', async () => {
  const defs = join(W, 'health');
  mkdirSync(defs, { recursive: true });
  writeFileSync(join(defs, 'defs.py'), [
    'from dagster import AssetCheckResult, Definitions, asset, asset_check',
    '@asset',
    'def broken(): return 1',
    '@asset_check(asset=broken)',
    'def broken_rule(): return AssetCheckResult(passed=False)',
    '@asset',
    'def fine(): return 1',
    '@asset_check(asset=fine)',
    'def fine_rule(): return AssetCheckResult(passed=True)',
    'defs = Definitions(assets=[broken, fine], asset_checks=[broken_rule, fine_rule])',
  ].join('\n'));
  execFileSync('chmod', ['-R', 'a+rwX', defs]);
  execFileSync('docker', ['run', '-d', '--name', DG, '-p', `127.0.0.1:${DG_PORT}:3000`, '-v', `${defs}:/defs`, '-e', 'HOME=/tmp', '-e', 'DAGSTER_HOME=/tmp/dh', IMAGE,
    'sh', '-c', 'mkdir -p $DAGSTER_HOME && cd /defs && dagster asset materialize -f defs.py --select "*" >/tmp/m.log 2>&1; exec dagster-webserver -f defs.py -h 0.0.0.0 -p 3000']);
  // Dagster OSS reports the checks' own executions; it serves no `assetHealth` rollup (Dagster+).
  const red = await until(() => feed.assetHealth(['broken']), (r) => r.ok && !!r.value?.checks.length && r.value.checks[0].status === 'FAILED', 180_000, 'Dagster reports the failed check', 2000);
  assert.ok(red.ok && red.value);
  assert.equal(red.value.colour, 'red');
  assert.deepEqual(red.value.checks, [{ name: 'broken_rule', status: 'FAILED', severity: 'ERROR' }]);
  const green = await feed.assetHealth(['fine']);
  assert.ok(green.ok && green.value);
  assert.deepEqual(green.value.checks.map((c) => c.status), ['SUCCEEDED']);
  assert.equal(green.value.colour, 'green');
  const none = await feed.assetHealth(['no', 'such', 'asset']);
  assert.ok(none.ok && none.value === null);
});
