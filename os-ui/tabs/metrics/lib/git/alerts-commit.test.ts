/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        metrics
 * FEATURE:    WP-50 (alerts) — the commit to git and the evaluation read back from git
 * USER STORY: As a creator I want my saved alert committed to my domain repo, and its evaluation to
 *             launch the image's MetricFlow job for exactly the committed rule, as me.
 * ARCHITECTURE:
 *   - Real git (temp repositories through the OS git store). Dagster is a recording stand-in here;
 *     the job itself runs in the real image in tests/metrics/alerts-eject.docker.test.ts.
 *   - NEGATIVE TWINS: an uncommitted rule is never launched; a failed run is `unavailable`, never a
 *     number from another path; the owner's identity is the run's OS_PRINCIPAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitSubtree } from '@core/infra/git-store';
import { VIEW, committedDbt } from '@tabs/metrics/lib/git/alerts-fixtures';
import { commitDomainAlerts } from '@tabs/metrics/lib/git/alerts-commit';
import { committedAlerts, evaluateCommittedAlert } from '@tabs/metrics/lib/build/alert-eval-metricflow';
import type { AlertRuleRecord } from '@tabs/metrics/lib/alert-store';

const V = VIEW;
const rule = (over: Partial<AlertRuleRecord> = {}): AlertRuleRecord => ({ id: 'rev_low', member: `${V}.revenue`, comparator: 'lt', threshold: 100, notify: ['in_app'], owner: 'amir', domain: 'sales', createdAt: '2026-11-20T10:00:00.000Z', ...over });

async function repoWithProject(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'wp50-alerts-'));
  const models = committedDbt();
  await commitSubtree('sales', 'models/', models, { reposDir: dir, author: { name: 'amir', email: 'amir@example.com' }, message: 'dbt project' });
  return dir;
}

type Launch = { jobName?: string; tags?: Record<string, string>; env?: Record<string, string> };
function fakeDagster(result: Record<string, unknown> | null, status = 'SUCCESS') {
  const launches: Launch[] = [];
  return {
    launches,
    dagster: {
      launchRun: async (i: Launch) => {
        launches.push(i);
        return { ok: true as const, data: { runId: 'r1', status: 'STARTED' as const } };
      },
      run: async () => ({ ok: true as const, data: { status } as never }),
      gql: async () => ({ ok: true as const, data: { runOrError: { eventConnection: { events: result ? [{ __typename: 'ExecutionStepOutputEvent', metadataEntries: [{ label: 'os_alert_result', jsonString: JSON.stringify(result) }] }] : [] } } } as never }),
    },
  };
}
const owner = async () => ({ id: 'amir', domains: ['sales'], role: 'creator' as const });

test('a saved rule is committed as metrics/alerts/<name>.yml, authored as the actor; a rule without a dbt metric is pending', async () => {
  const dir = await repoWithProject();
  try {
    const r = await commitDomainAlerts('sales', [rule(), rule({ id: 'm', member: `${V}.margin` })], { id: 'amir', name: 'Amir', email: 'amir@example.com' }, { reposDir: dir });
    assert.ok(r.commit?.changed);
    assert.equal(r.pending.length, 1);
    const head = await committedAlerts('sales', dir);
    assert.equal(head.sha, r.commit!.sha);
    assert.deepEqual(head.alerts.map((a) => [a.path, a.metric, a.comparator, a.threshold]), [['metrics/alerts/rev_low.yml', 'revenue', 'lt', 100]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluation launches the committed alert\'s MetricFlow job as the owner, at the commit it read, and relays its result', async () => {
  const dir = await repoWithProject();
  try {
    const c = await commitDomainAlerts('sales', [rule()], { id: 'amir' }, { reposDir: dir });
    const f = fakeDagster({ status: 'ok', value: 36, breached: true, comparator: 'lt', threshold: 100 });
    const e = await evaluateCommittedAlert(rule(), { dagster: f.dagster as never, owner, reposDir: dir, sleep: async () => {} });
    assert.equal(e.status, 'ok');
    assert.deepEqual(e.status === 'ok' ? [e.value, e.breached, e.committed.threshold] : [], [36, true, 100]);
    assert.equal(f.launches.length, 1);
    assert.equal(f.launches[0].jobName, 'sales__alert_rev_low');
    assert.equal('env' in f.launches[0], false);
    assert.equal(f.launches[0].tags?.['os/pinned'], `sales=${c.commit!.sha}`);
    assert.equal(f.launches[0].tags?.['os/principal'], 'amir');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NEGATIVE TWINS: an uncommitted rule is pending and never launched; a failed run is unavailable', async () => {
  const dir = await repoWithProject();
  try {
    const f = fakeDagster({ status: 'ok', value: 1, breached: false });
    const e = await evaluateCommittedAlert(rule({ id: 'only_in_store' }), { dagster: f.dagster as never, owner, reposDir: dir, sleep: async () => {} });
    assert.equal(e.status, 'pending');
    assert.equal(f.launches.length, 0);

    await commitDomainAlerts('sales', [rule()], { id: 'amir' }, { reposDir: dir });
    const failed = fakeDagster(null, 'FAILURE');
    const u = await evaluateCommittedAlert(rule(), { dagster: failed.dagster as never, owner, reposDir: dir, sleep: async () => {} });
    assert.equal(u.status, 'unavailable');
    const noResult = fakeDagster(null);
    assert.equal((await evaluateCommittedAlert(rule(), { dagster: noResult.dagster as never, owner, reposDir: dir, sleep: async () => {} })).status, 'unavailable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an owner that no longer exists is orphaned and never launched', async () => {
  const f = fakeDagster({ status: 'ok', value: 1, breached: false });
  const e = await evaluateCommittedAlert(rule(), { dagster: f.dagster as never, owner: async () => null, reposDir: '/nonexistent', sleep: async () => {} });
  assert.equal(e.status, 'orphaned');
  assert.equal(f.launches.length, 0);
});

test('MIGRATION DRY RUN: an os-alert-rules _search export plans files per domain, pending and refused rules; nothing is written', async () => {
  const { alertRulesFromJson, planAlertMigration } = await import('@tabs/metrics/lib/git/alerts-migrate-plan');
  const exp = JSON.stringify({ hits: { hits: [{ _source: rule() }, { _source: rule({ id: 'no_metric', member: `${V}.margin` }) }, { _source: { id: 'broken', member: 7 } }] } });
  const { rules, refused } = alertRulesFromJson(exp);
  const dbt = committedDbt();
  const plan = planAlertMigration(rules, refused, () => dbt);
  assert.equal(plan.mode, 'dry-run');
  assert.deepEqual(plan.domains, [{ domain: 'sales', files: ['metrics/alerts/rev_low.yml'], dbtFiles: dbt.size }]);
  assert.deepEqual(plan.pending.map((p) => p.id), ['no_metric']);
  assert.deepEqual(plan.refused.map((r) => r.id), ['broken']);
});

test('NEGATIVE TWIN: a committed alert whose owner token is not the store owner\'s is refused and never launched', async () => {
  const dir = await repoWithProject();
  try {
    // bea's rule committed under amir's name: e.g. a file edited to point at amir's owner token.
    await commitDomainAlerts('sales', [rule({ owner: 'bea' })], { id: 'bea' }, { reposDir: dir });
    const f = fakeDagster({ status: 'ok', value: 1, breached: false });
    const e = await evaluateCommittedAlert(rule({ owner: 'amir' }), { dagster: f.dagster as never, owner, reposDir: dir, sleep: async () => {} });
    assert.equal(e.status, 'refused');
    assert.match(e.status === 'refused' ? e.reason : '', /owner/);
    assert.equal(f.launches.length, 0, 'it never runs as the store owner');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
