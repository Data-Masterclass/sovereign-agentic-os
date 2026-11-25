/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Delete domain against REAL Dagster: the domain's schedules are stopped, its repo is
 *             removed, repo-sync prunes its checkout, and GraphQL shows none of its definitions
 * USER STORY: As the admin deleting a domain I want Dagster to stop scheduling and loading it —
 *             no job, schedule, sensor or asset of the domain left — while the other domain loads.
 * ARCHITECTURE:
 *   - The image we ship (dagster-webserver on repo.py + repo-sync.sh), started by
 *     images/extensions/dagster/tests/image/domain-prune.sh over a repos directory that this test
 *     owns as os-ui's `OS_REPOS_DIR`. The OS index is the list of bare repos there.
 *   - The component under test is the one that ships (`gitRepoComponent`, core), over the real
 *     Dagster GraphQL API; the engine runs it.
 *   - Negative twin: the verification step, run BEFORE the repo is deleted, must FAIL — so a
 *     green run cannot come from a check that sees nothing.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const URL_ = process.env.DD_DAGSTER_URL ?? '';
const REPOS = process.env.DD_REPOS ?? '';
const skip = URL_ && REPOS ? false : 'DD_DAGSTER_URL / DD_REPOS not set (start images/extensions/dagster/tests/image/domain-prune.sh)';
process.env.OS_REPOS_DIR = REPOS || process.env.OS_REPOS_DIR || '';

const K = 'ddka';
const O = 'ddob';
const dagster = { url: URL_ };

function makeRepo(domain: string): void {
  const work = mkdtempSync(join(tmpdir(), `dd-${domain}-`));
  mkdirSync(join(work, 'models'), { recursive: true });
  writeFileSync(join(work, 'dbt_project.yml'), `name: ${domain}\nversion: '1.0'\nconfig-version: 2\nprofile: sovereign\nmodel-paths: [models]\n`);
  writeFileSync(join(work, 'profiles.yml'), readFileSync(new URL('../../images/extensions/dbt/project/profiles.yml', import.meta.url), 'utf8'));
  writeFileSync(join(work, 'models', `gold_${domain}.sql`), "{{ config(materialized='table', schema='" + domain + "') }}\nselect 1 as x\n");
  const git = (...a: string[]) => execFileSync('git', a, { cwd: work, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=it@example.org', '-c', 'user.name=it', 'add', '-A');
  git('-c', 'user.email=it@example.org', '-c', 'user.name=it', 'commit', '-q', '-m', 'init');
  execFileSync('git', ['clone', '-q', '--bare', work, join(REPOS, `domain-${domain}.git`)]);
  execFileSync('chmod', ['-R', 'a+rwX', join(REPOS, `domain-${domain}.git`)]);
}

let dg: typeof import('../../os-ui/core/infra/dagster');
let comps: typeof import('../../os-ui/core/kernel/domain-delete-components');
let engine: typeof import('../../os-ui/core/kernel/domain-delete');

before(async () => {
  if (skip) return;
  makeRepo(K);
  makeRepo(O);
  dg = await import('@core/infra/dagster');
  comps = await import('@core/kernel/domain-delete-components');
  engine = await import('@core/kernel/domain-delete');
  // repo-sync clones, `dbt parse`s and repoints; the location reloads. Wait for both domains.
  const end = Date.now() + 240_000;
  for (;;) {
    await dg.reloadLocation(undefined, dagster);
    const a = await dg.domainDefinitions(K, dagster);
    const b = await dg.domainDefinitions(O, dagster);
    if (a.ok && b.ok && a.data.jobs.includes(`${K}__all`) && b.data.jobs.includes(`${O}__all`)) break;
    if (Date.now() > end) throw new Error(`Dagster never loaded both domains: ${JSON.stringify({ a, b })}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
});

test('the domain is live in Dagster before the delete (jobs, a RUNNING weekly maintenance schedule, its asset group)', { skip }, async () => {
  const d = await dg.domainDefinitions(K, dagster);
  assert.ok(d.ok);
  if (!d.ok) return;
  assert.ok(d.data.jobs.includes(`${K}__all`));
  const weekly = d.data.schedules.find((s) => /__maintenance__.*_weekly$/.test(s.name));
  assert.ok(weekly, JSON.stringify(d.data.schedules));
  assert.equal(weekly!.status, 'RUNNING');
  assert.deepEqual(d.data.assetGroups, [K]);
});

test('negative twin: the verification step FAILS while the domain is still loaded', { skip }, async () => {
  const c = comps.gitRepoComponent({ dagster, verifyTimeoutMs: 8000, pollMs: 2000 });
  await assert.rejects(c.remove({ component: 'git', kind: 'dagster-definitions', id: K, label: 'verify' }, { domainId: K, actor: { id: 'it', role: 'admin', domains: [K] } }), /still holds ddka/);
});

test('delete: schedules stopped, repo removed, checkout pruned, nothing of the domain left in GraphQL; the other domain stays', { skip }, async () => {
  const c = comps.gitRepoComponent({ dagster, verifyTimeoutMs: 120_000, pollMs: 3000 });
  const r = await engine.deleteDomain(K, { dryRun: false, confirm: K, iHaveABackup: true }, {
    actor: { id: 'it', role: 'admin', domains: [K, O] },
    components: [c],
    audit: () => {},
    backup: async () => ({ ok: false, reason: 'n/a' }),
    deleteWindow: () => true,
  });
  assert.equal(r.status, 'done', JSON.stringify(r));
  if (r.status !== 'done') return;
  const kinds = r.done.map((d) => d.kind);
  assert.deepEqual(kinds, ['stop-schedule', 'repo', 'dagster-definitions'], 'stop first, then the repo, then the GraphQL check');
  assert.ok(r.done[0].evidence.startsWith('stopped '));
  const after = await dg.domainDefinitions(K, dagster);
  assert.ok(after.ok);
  if (after.ok) assert.deepEqual(after.data, { jobs: [], schedules: [], sensors: [], assetGroups: [] });
  const other = await dg.domainDefinitions(O, dagster);
  assert.ok(other.ok && other.data.jobs.includes(`${O}__all`) && other.data.assetGroups.includes(O), 'the other domain is still loaded');
  // re-run: nothing left to plan
  const again = await engine.deleteDomain(K, {}, { actor: { id: 'it', role: 'admin', domains: [K] }, components: [c], audit: () => {}, backup: async () => ({ ok: false, reason: 'n/a' }), deleteWindow: () => true });
  assert.equal(again.plan.totals.remove, 0);
});
