/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Layout migration tests, read back with the REAL git CLI and the REAL dbt
 * USER STORY: As an operator I want proof that the migration keeps every file's history
 *             (`git log --follow`), is one commit, is idempotent, has a dry run that writes
 *             nothing, moves personal agent lanes to their owners' repos with their history, leaves
 *             the old repo name working, does not trip the destructive-delta guard on the next boot
 *             reconcile, and that `cd data/dbt && dbt parse` works on a clone afterwards.
 * ARCHITECTURE:
 *   - A temp `reposDir`; repos are written by the git store exactly as in production, then read
 *     with `git` itself (`git clone`, `git log --follow`), never with isomorphic-git.
 *   - The dbt half runs `dbt parse` in the Dagster image (the WP-03 eject image) when docker and
 *     the image are present; otherwise it is SKIPPED with the reason — never faked.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  commitTree, reserveSubtree, RECONCILE_REASON, listRepos, repoPath, readBlob, DestructiveReconcileError,
} from '@core/infra/git-store';
import { migrateRepoLayout, planLayoutMigration, MIGRATION_REASON } from '@core/infra/repo-layout-migrate';
import { LAYOUT_V2, LAYOUT_MARKER_PATH, dbtRepoPath, layoutMarker, legacyPersonalAgentLane, userRepoName } from '@core/infra/repo-layout';
import { GENERATED_MARK } from '@core/infra/repo-readme';

const author = { name: 'Alice', email: 'alice@example.com' };
let reposDir = '';

function gitc(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir() } });
}

function golden(name: string): Map<string, string> {
  const file = path.join(process.cwd(), 'tabs/data/lib/dbt/fixtures', name);
  return new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>));
}

before(() => {
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp55-migrate-'));
  reserveSubtree('agents/');
});

/** A v1 domain repo: the golden's dbt project at the root + a shared and a personal agent system,
 *  with a SECOND commit that changes one model (so there is history to follow). */
async function seedV1(domain: string): Promise<{ project: Map<string, string>; model: string }> {
  const project = golden('composition-with-tests.golden.json');
  const model = [...project.keys()].find((p) => p.startsWith('models/') && p.endsWith('.sql'))!;
  const lane = legacyPersonalAgentLane('alice@example.com');
  const tree = new Map(project);
  tree.set('agents/index.yml', 'version: 1\nsystems: []\n');
  tree.set('agents/shared-bot/system.yaml', 'name: shared\n');
  tree.set(`${lane}my-bot/system.yaml`, 'name: mine\n');
  await commitTree(domain, tree, { author, message: 'data(x): first', reposDir, timestamp: 1_700_000_000 });
  tree.set(model, `${project.get(model)}-- second edit\n`);
  tree.set(`${lane}my-bot/system.yaml`, 'name: mine v2\n');
  await commitTree(domain, tree, { author, message: 'data(x): second', reposDir, timestamp: 1_700_000_100 });
  project.set(model, tree.get(model)!);
  return { project, model };
}

test('dry run: reports the plan and writes nothing', async () => {
  await seedV1('dry');
  const before = gitc(['--git-dir', repoPath('dry', { reposDir }), 'rev-parse', 'main']).trim();
  const r = await migrateRepoLayout('dry', { reposDir, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.rename, true);
  assert.ok(r.moves.some((m) => m.to === 'data/dbt/dbt_project.yml'));
  assert.equal(r.personal.length, 1);
  assert.ok(r.readmes.includes('README.md') && r.readmes.includes('data/README.md'));
  assert.equal(gitc(['--git-dir', repoPath('dry', { reposDir }), 'rev-parse', 'main']).trim(), before);
  assert.ok(fs.existsSync(path.join(reposDir, 'dry.git')) && !fs.existsSync(path.join(reposDir, 'domain-dry.git')));
});

test('apply: one commit of pure moves; git log --follow keeps a model\'s history; alias + idempotent', async () => {
  const { project, model } = await seedV1('sales');
  const r = await migrateRepoLayout('sales', { reposDir, timestamp: 1_700_000_200 });
  assert.ok(r.sha);
  // renamed, and the old name is an alias that git itself can clone
  assert.ok(fs.lstatSync(path.join(reposDir, 'sales.git')).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(reposDir, 'domain-sales.git', 'HEAD')));
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'wp55-clone-'));
  gitc(['clone', '-q', path.join(reposDir, 'sales.git'), clone]);
  // the migration commit: made by the OS, with the trailer, ONLY renames + additions
  const msg = gitc(['log', '-1', '--format=%an%n%B'], clone);
  assert.match(msg, /^Sovereign OS/);
  assert.match(msg, new RegExp(`OS-Reason: ${MIGRATION_REASON}`));
  const status = gitc(['show', '--name-status', '-M100%', '--format=', 'HEAD'], clone).trim().split('\n');
  // Only renames at 100% similarity, additions (marker + READMEs), the personal lane's removal —
  // and the root README.md, which becomes the generated repo README (the dbt project's README
  // moves to data/dbt/README.md byte-identical, which git reports as an add beside that change).
  assert.ok(
    status.every((l) => /^(R100|A|D)\t/.test(l) || l === 'M\tREADME.md'),
    `only renames, additions and the personal lane's removal: ${status.join(' | ')}`,
  );
  assert.ok(status.filter((l) => l.startsWith('R')).length >= 10, 'the dbt files are detected as renames');
  assert.ok(status.filter((l) => l.startsWith('D\t')).every((l) => l.includes('agents/personal/')));
  // history follows the move
  const follow = gitc(['log', '--follow', '--format=%s', '--', `data/dbt/${model}`], clone).trim().split('\n');
  assert.equal(follow.length, 3, follow.join(' | '));
  assert.match(follow[0], /migrate repository layout/);
  assert.ok(follow.includes('data(x): first') && follow.includes('data(x): second'), follow.join(' | '));
  // layout: dbt under data/dbt, os/ + agents/ in place, READMEs generated
  assert.ok(fs.existsSync(path.join(clone, 'data/dbt/dbt_project.yml')));
  assert.ok(!fs.existsSync(path.join(clone, 'dbt_project.yml')));
  assert.ok(fs.existsSync(path.join(clone, 'os/layout.yml')));
  assert.ok(fs.readFileSync(path.join(clone, 'README.md'), 'utf8').startsWith(GENERATED_MARK));
  assert.ok(fs.readFileSync(path.join(clone, 'data/README.md'), 'utf8').includes('cd data/dbt && dbt'));
  assert.ok(!fs.existsSync(path.join(clone, 'agents/personal')), 'the personal lane left the domain repo');
  // the index still lists the domain
  assert.deepEqual((await listRepos({ reposDir })).filter((x) => x.name === 'sales').map((x) => x.repo), ['domain-sales']);
  // idempotent
  const again = await migrateRepoLayout('sales', { reposDir });
  assert.equal(again.sha, null);
  assert.equal(again.alreadyMigrated, true);
  // the next boot reconcile regenerates the SAME tree at the new paths: no guard, no commit
  // What the data generator commits in a v2 repo (tabs/data/lib/dbt/layout.ts `relocateProject`):
  // every project path under the dbt dir, plus the marker. Spelled with the core helpers here —
  // a core test may not import a tab.
  const regenerated = new Map([...project].map(([p, c]) => [dbtRepoPath(p, LAYOUT_V2), c] as [string, string]));
  regenerated.set(LAYOUT_MARKER_PATH, layoutMarker());
  const rec = await commitTree('sales', regenerated, { author, message: 'data(sales): reconcile', trailers: { 'OS-Reason': RECONCILE_REASON }, reposDir });
  assert.equal(rec.changed, false, 'the reconcile after migration is a no-op');
  // negative twin: had the generator NOT followed the layout (still writing the root), the guard
  // would have been the thing standing between it and the moved project.
  await assert.rejects(
    commitTree('sales', new Map([['os/layout.yml', regenerated.get('os/layout.yml')!]]), { author, message: 'x', trailers: { 'OS-Reason': RECONCILE_REASON }, reposDir }),
    DestructiveReconcileError,
  );
});

test('apply: the personal lane moves to the owner\'s user repo WITH its history', async () => {
  const repo = userRepoName('alice@example.com');
  const plan = await planLayoutMigration('sales', { reposDir });
  assert.equal(plan.alreadyMigrated, true);
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'wp55-user-'));
  gitc(['clone', '-q', path.join(reposDir, `${repo}.git`), clone]);
  assert.equal(fs.readFileSync(path.join(clone, 'agents/my-bot/system.yaml'), 'utf8'), 'name: mine v2\n');
  assert.ok(fs.existsSync(path.join(clone, 'os/layout.yml')));
  const hist = gitc(['log', '--format=%s', '--', 'agents/my-bot/system.yaml'], clone);
  assert.match(hist, /data\(x\): second/);
  assert.match(hist, /data\(x\): first/);
  assert.equal(await readBlob(repo, 'main', 'agents/my-bot/system.yaml', { reposDir }), 'name: mine v2\n');
});

test('eject after migration: `cd data/dbt && dbt parse` in the Dagster image (WP-03 eject)', async (t) => {
  const image = process.env.WP55_DAGSTER_IMAGE ?? 'ghcr.io/aborek/sovereign-os/dagster:0.3.1';
  const docker = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8' });
  if (docker.status !== 0) {
    t.skip(`docker or ${image} not available — run with the image present (CI: images/extensions/dagster/tests/image/run.sh covers the v2 layout)`);
    return;
  }
  // Under $HOME: the docker VM (colima / Docker Desktop) shares the home directory, not /var/folders.
  const scratch = path.join(os.homedir(), '.cache', 'wp55-eject');
  fs.mkdirSync(scratch, { recursive: true });
  const clone = fs.mkdtempSync(path.join(scratch, 'clone-'));
  gitc(['clone', '-q', path.join(reposDir, 'sales.git'), clone]);
  fs.chmodSync(clone, 0o777);
  const run = spawnSync(
    'docker',
    ['run', '--rm', '-v', `${clone}:/repo`, '-w', '/repo/data/dbt', '-e', 'DBT_SEND_ANONYMOUS_USAGE_STATS=false', '-e', 'TRINO_USER=alice', '-e', 'TRINO_HOST=localhost',
      '--entrypoint', 'dbt', image, 'parse', '--profiles-dir', '.', '--target', 'local', '--no-use-colors', '--target-path', '/tmp/target', '--log-path', '/tmp/logs'],
    { encoding: 'utf8', timeout: 300_000 },
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`.slice(-3000));
  // negative twin: the SAME parse at the repo root (the old place) must fail — the project moved.
  const root = spawnSync(
    'docker',
    ['run', '--rm', '-v', `${clone}:/repo`, '-w', '/repo', '--entrypoint', 'dbt', image, 'parse', '--profiles-dir', '.', '--target', 'local', '--no-use-colors', '--target-path', '/tmp/target', '--log-path', '/tmp/logs'],
    { encoding: 'utf8', timeout: 300_000 },
  );
  assert.notEqual(root.status, 0, 'dbt must not find a project at the repo root after migration');
});

test('Dagster loads the migrated project: repo-sync reports "current", the code location lists its assets', async (t) => {
  const image = process.env.WP55_DAGSTER_IMAGE ?? 'ghcr.io/aborek/sovereign-os/dagster:0.3.1';
  if (spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8' }).status !== 0) {
    t.skip(`docker or ${image} not available`);
    return;
  }
  // The repos dir (with the `sales.git` alias symlink) is copied under $HOME for the docker VM.
  const scratch = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'wp55-dagster-'));
  fs.cpSync(reposDir, path.join(scratch, 'repos'), { recursive: true, verbatimSymlinks: true });
  const app = path.resolve(process.cwd(), '../images/extensions/dagster'); // THIS branch's scripts, not the image's
  const head = gitc(['--git-dir', path.join(reposDir, 'domain-sales.git'), 'rev-parse', 'main']).trim();
  const script = [
    'set -e',
    "git config --global --add safe.directory '*'",
    'git daemon --export-all --base-path=/repos --port=9418 --reuseaddr --listen=127.0.0.1 --detach',
    'export REPO_SYNC_ENABLED=true POD_NAME=wp55-codeserver REPO_SYNC_INDEX_URL= REPO_SYNC_DOMAINS=sales REPO_SYNC_GIT_BASE=git://127.0.0.1 REPO_SYNC_CHECKOUT=/tmp/co REPO_SYNC_INTERVAL=3 DAGSTER_RELOAD_LOCATION= APP_DIR=/app',
    'sh /app/repo-sync.sh > /tmp/sync.log 2>&1 &',
    'i=0; until python3 -c "import json,sys;d=json.load(open(\'/tmp/co/status.json\'))[\'domains\'].get(\'sales\') or {};sys.exit(0 if d.get(\'current\') and d.get(\'current\')==d.get(\'head\') else 1)" 2>/dev/null; do i=$((i+1)); [ $i -lt 100 ] || { cat /tmp/sync.log; cat /tmp/co/status.json; exit 3; }; sleep 3; done',
    'echo STATUS=$(cat /tmp/co/status.json)',
    'cd /app && REPO_SYNC_CHECKOUT=/tmp/co python3 -c "import os_projects as o; ps,sk=o.discover(\'/tmp/co\'); print(\'PROJECTS=\'+\';\'.join(p.domain+\'@\'+p.path for p in ps)); print(\'SKIPPED=\'+\';\'.join(s.reason for s in sk))"',
    'cd /app && REPO_SYNC_CHECKOUT=/tmp/co dagster asset list -f /app/repo.py 2>/dev/null | sed "s/^/ASSET=/" | head -50',
  ].join('\n');
  const run = spawnSync('docker', ['run', '--rm', '-v', `${path.join(scratch, 'repos')}:/repos:ro`, '-v', `${app}:/app:ro`, '--entrypoint', 'sh', image, '-c', script], {
    encoding: 'utf8',
    timeout: 600_000,
  });
  const out = `${run.stdout}\n${run.stderr}`;
  assert.equal(run.status, 0, out.slice(-3000));
  const status = JSON.parse(/STATUS=(.*)/.exec(out)![1]) as { domains: Record<string, { current: string; head: string; error: string | null }> };
  assert.equal(status.domains.sales.current, head, 'repo-sync reports the migrated head as current');
  assert.equal(status.domains.sales.error, null);
  assert.match(out, /PROJECTS=sales@\/tmp\/co\/sales\/[0-9a-f]{40}\/data\/dbt/, 'the Dagster loader points dbt at data/dbt');
  assert.match(out, /ASSET=.*silver_customers/, `the code location lists the migrated project's dbt assets:\n${out.slice(-2000)}`);
});
