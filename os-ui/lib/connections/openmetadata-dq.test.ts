/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyVersions, type Dataset, type DataCheck, type OmWrite } from '@/lib/data';
import { OS_SERVICE, MANAGED_BY } from '@/lib/connections/openmetadata-sync';
import {
  mapRuleToOmTests,
  buildDqSyncPlan,
  previewDqSync,
  applyDqSync,
  osDqSuiteFqn,
  osDqTableFqn,
  osDqTestCaseFqnsForRule,
  type OmDqSyncClient,
  type OmDqPutOp,
} from '@/lib/connections/openmetadata-dq';

// --- A promoted asset Dataset factory (Gold built) with DQ rules ---------------
function check(over: Partial<DataCheck> = {}): DataCheck {
  return { id: 'c1', name: '', description: '', createdBy: 'amir', createdAt: '', rule: 'not_null', column: 'id', ...over };
}
function asset(checks: DataCheck[] = [check()], over: Partial<Dataset> = {}): Dataset {
  const versions = emptyVersions();
  versions.bronze.built = true;
  versions.silver.built = true;
  versions.gold.built = true;
  return {
    version: '1', id: 'ds_orders', name: 'Orders', owner: 'amir', domain: 'sales',
    tier: 'asset', visibility: 'shared', folder: '/', description: 'Sales orders.',
    versions, grants: [], measures: [], columns: [{ name: 'id', description: 'Key.' }],
    checks,
    ...over,
  } as Dataset;
}

// --- A FAKE OM DQ client — records every PUT, no network -----------------------
function fakeClient(omVersion = '1.5.0'): { client: OmDqSyncClient; puts: { path: string; body: Record<string, unknown> }[] } {
  const puts: { path: string; body: Record<string, unknown> }[] = [];
  const client: OmDqSyncClient = {
    omVersion,
    putEntity: async (path, body): Promise<OmWrite> => {
      puts.push({ path, body: body as Record<string, unknown> });
      return { ok: true, data: body };
    },
  };
  return { client, puts };
}

// =============================== mapping =======================================

test('mapRuleToOmTests: every OS rule kind maps to the right OM TestDefinition(s)', () => {
  assert.deepEqual(mapRuleToOmTests(check({ rule: 'not_null' })).map((s) => s.testDefinition), ['columnValuesToBeNotNull']);
  assert.deepEqual(mapRuleToOmTests(check({ rule: 'unique' })).map((s) => s.testDefinition), ['columnValuesToBeUnique']);
  assert.deepEqual(
    mapRuleToOmTests(check({ rule: 'not_blank' })).map((s) => s.testDefinition),
    ['columnValuesToBeNotNull', 'columnValueLengthsToBeBetween'],
    'not_blank fans out to NotNull + LengthsToBeBetween(min:1)',
  );
  const notBlankLen = mapRuleToOmTests(check({ rule: 'not_blank' }))[1];
  assert.deepEqual(notBlankLen.parameters, [{ name: 'minLength', value: '1' }]);

  const accepted = mapRuleToOmTests(check({ rule: 'accepted_values', values: ['A', 'B'] }));
  assert.deepEqual(accepted.map((s) => s.testDefinition), ['columnValuesToBeInSet']);
  assert.deepEqual(accepted[0].parameters, [{ name: 'allowedValues', value: JSON.stringify(['A', 'B']) }]);

  const range = mapRuleToOmTests(check({ rule: 'range', min: 0, max: 10 }));
  assert.deepEqual(range.map((s) => s.testDefinition), ['columnValuesToBeBetween']);
  assert.deepEqual(range[0].parameters, [{ name: 'minValue', value: '0' }, { name: 'maxValue', value: '10' }]);
});

test('mapRuleToOmTests: non-executable rules map to NOTHING (never invented)', () => {
  assert.deepEqual(mapRuleToOmTests(check({ rule: undefined })), [], 'free-text intention → no OM test');
  assert.deepEqual(mapRuleToOmTests(check({ rule: 'not_null', column: '' })), [], 'no column → no OM test');
  assert.deepEqual(mapRuleToOmTests(check({ rule: 'accepted_values', values: [] })), [], 'empty set → no OM test');
  assert.deepEqual(mapRuleToOmTests(check({ rule: 'range', min: undefined, max: undefined })), [], 'no bounds → no OM test');
});

// =============================== plan shape ====================================

test('buildDqSyncPlan: a Basic TestSuite bound to the OS mart + one TestCase per rule, all OS-namespaced + managedBy', () => {
  const d = asset([check({ id: 'c1', rule: 'not_null', column: 'id' }), check({ id: 'c2', rule: 'range', column: 'amount', min: 0 })]);
  const plan = buildDqSyncPlan(d, { runId: 'r1' });
  assert.equal(plan.rejected, undefined);

  const suite = plan.puts.find((p) => p.kind === 'testSuite')!;
  assert.equal(suite.path, '/api/v1/dataQuality/testSuites');
  assert.equal(suite.fqn, osDqSuiteFqn(d));
  assert.equal(suite.body.basicEntityReference, osDqTableFqn(d), 'Basic/executable suite is bound 1:1 to the OS gold table');
  assert.equal(suite.body.name, osDqSuiteFqn(d));

  const cases = plan.puts.filter((p) => p.kind === 'testCase');
  assert.equal(cases.length, 2, 'one TestCase per executable rule');
  for (const c of cases) {
    assert.equal(c.path, '/api/v1/dataQuality/testCases');
    assert.ok(c.fqn.startsWith(`${OS_SERVICE}.`), 'every TestCase FQN is OS-namespaced (Guard 1)');
    assert.equal((c.body.extension as Record<string, unknown>).managedBy, MANAGED_BY, 'stamped managedBy (Guard 3)');
    assert.equal(c.body.testSuite, osDqSuiteFqn(d), 'the case references its suite');
  }
  // every OS DQ entity carries the managedBy stamp
  assert.equal((suite.body.extension as Record<string, unknown>).managedBy, MANAGED_BY);
});

test('buildDqSyncPlan: rejects when not promoted / no Gold / no executable rule (honest reasons)', () => {
  const noGold = asset([check()], { versions: emptyVersions() });
  assert.ok(buildDqSyncPlan(noGold, { runId: 'r' }).rejected?.includes('Gold'));

  const notPromoted = asset([check()], { tier: 'dataset' });
  assert.ok(buildDqSyncPlan(notPromoted, { runId: 'r' }).rejected?.includes('promote'));

  const noRules = asset([]);
  assert.ok(buildDqSyncPlan(noRules, { runId: 'r' }).rejected?.includes('No executable'));

  const onlyFreeText = asset([check({ rule: undefined, name: 'freeform' })]);
  assert.ok(buildDqSyncPlan(onlyFreeText, { runId: 'r' }).rejected?.includes('No executable'));
});

test('previewDqSync: honest diff — counts + touch ZERO human fields; rejected plan is not ok', () => {
  const plan = buildDqSyncPlan(asset([check({ rule: 'not_blank', column: 'name' })]), { runId: 'r' });
  const pv = previewDqSync(plan);
  assert.equal(pv.ok, true);
  assert.equal(pv.counts.suites, 1);
  assert.equal(pv.counts.testCases, 2, 'not_blank yields two TestCases');
  assert.equal(pv.counts.humanFieldsTouched, 0);
  assert.ok(pv.summary.includes('ZERO human fields'));

  const rej = previewDqSync(buildDqSyncPlan(asset([]), { runId: 'r' }));
  assert.equal(rej.ok, false);
  assert.ok(rej.rejected);
});

// =============================== apply + guards ================================

test('applyDqSync: PUTs the suite BEFORE its test cases, idempotent, all under the OS namespace', async () => {
  const d = asset([check({ id: 'c1', rule: 'unique', column: 'id' })]);
  const { client, puts } = fakeClient();
  const res = await applyDqSync(client, buildDqSyncPlan(d, { runId: 'r' }));
  assert.equal(res.ok, true);
  assert.equal(res.applied.suites, 1);
  assert.equal(res.applied.testCases, 1);
  assert.equal(puts[0].path, '/api/v1/dataQuality/testSuites', 'suite is PUT first');
  assert.equal(puts[1].path, '/api/v1/dataQuality/testCases');
});

test('applyDqSync: fail-closed on an out-of-range OM version — refuses, writes NOTHING', async () => {
  const { client, puts } = fakeClient('1.2.0'); // below TESTED_OM_MIN
  const res = await applyDqSync(client, buildDqSyncPlan(asset(), { runId: 'r' }));
  assert.equal(res.ok, false);
  assert.ok(res.refused?.includes('outside the tested write range'));
  assert.equal(puts.length, 0, 'no PUT was attempted on an untested OM');
});

test('applyDqSync: refuses a plan that targets a NON-OS-namespace entity (Guard 1) — no partial write', async () => {
  const d = asset();
  const plan = buildDqSyncPlan(d, { runId: 'r' });
  // Tamper the plan to point at a human FQN (as a malicious/buggy caller might).
  const tampered = {
    ...plan,
    puts: plan.puts.map((p): OmDqPutOp => (p.kind === 'testCase' ? { ...p, fqn: 'trino.iceberg.sales.orders.id.x' } : p)),
  };
  const { client, puts } = fakeClient();
  const res = await applyDqSync(client, tampered);
  assert.equal(res.ok, false);
  assert.ok(res.refused?.includes('non-OS-namespace'));
  assert.equal(puts.length, 0, 'refused wholesale before any write (never a partial write)');
});

test('applyDqSync: a rejected plan refuses without writing', async () => {
  const { client, puts } = fakeClient();
  const res = await applyDqSync(client, buildDqSyncPlan(asset([]), { runId: 'r' }));
  assert.equal(res.ok, false);
  assert.ok(res.refused);
  assert.equal(puts.length, 0);
});

// =============================== result-append map =============================

test('osDqTestCaseFqnsForRule: the append map matches the FQNs the plan provisioned', () => {
  const d = asset([check({ id: 'c1', rule: 'not_blank', column: 'name' })]);
  const plan = buildDqSyncPlan(d, { runId: 'r' });
  const provisioned = plan.puts.filter((p) => p.kind === 'testCase').map((p) => p.fqn).sort();
  const forRule = osDqTestCaseFqnsForRule(d, d.checks![0]).sort();
  assert.deepEqual(forRule, provisioned, 'a run appends its verdict to exactly the FQNs the plan created');
  assert.equal(forRule.length, 2, 'not_blank fans out to two TestCase FQNs');
});
