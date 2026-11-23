/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The immediate OPA push on a dataset tier change (certify / decertify / unshare)
 * USER STORY: As a member of another domain I can query a dataset the moment it is certified to
 *             Company, and lose access the moment it is decertified — and a failed push is shown.
 * ARCHITECTURE:
 *   - Drives the REAL store write path (`persist` → the policy-push port) and the REAL push module
 *     (`pushDatasetPolicyNow`) with an injected `push` that records the bundle it was handed — the
 *     same `PolicyClient.push` contract the build uses.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore, createDataset, buildVersion, transition, certify, setDatasetPolicyPushPort, awaitDatasetPolicyPush, policyPushReport,
  type Principal,
} from '@tabs/data/lib/store';
import { pushDatasetPolicyNow } from '@tabs/data/lib/policy/push-now';
import { tableFqn, type OpaBundle } from '@tabs/data/lib/policy/compiler';
import { getDataset } from '@tabs/data/lib/store';

const admin: Principal = { id: 'sara', domains: ['sales'], role: 'admin' };
let pushed: OpaBundle[] = [];
let failWith: string | null = null;

beforeEach(() => {
  __resetStore();
  pushed = []; failWith = null;
  setDatasetPolicyPushPort((d, actor, via) => pushDatasetPolicyNow(d, actor, via, {
    roster: async () => ({ sara: { domains: ['sales'] } }),
    push: async (opa) => { if (failWith) throw new Error(failWith); pushed.push(opa); },
  }));
});
afterEach(() => setDatasetPolicyPushPort(null));

function asset(): string {
  const d = createDataset(admin, { name: 'Orders', domain: 'sales' });
  buildVersion(d.id, admin, 'bronze', { quality: 'passing', artifact: 'b' });
  buildVersion(d.id, admin, 'silver', { quality: 'passing', artifact: 's' });
  transition(d.id, admin, 'promote', { visibility: 'domain' });
  return d.id;
}

test('certify → the policy push runs at once with the table PUBLIC (readable in every domain)', async () => {
  const id = asset();
  await awaitDatasetPolicyPush(id); pushed = []; // the promote's own push
  certify(id, admin, {});
  const out = await awaitDatasetPolicyPush(id);
  assert.deepEqual(out && out.ok, true);
  assert.equal(pushed.length, 1, 'exactly one push');
  const fqn = tableFqn(getDataset(id, admin));
  assert.equal(pushed[0].tables[fqn].visibility, 'public');
});

test('decertify → the push carries the NARROWED policy (no longer public)', async () => {
  const id = asset();
  certify(id, admin, {});
  await awaitDatasetPolicyPush(id); pushed = [];
  transition(id, admin, 'decertify');
  const out = await awaitDatasetPolicyPush(id);
  assert.equal(out?.ok, true);
  const fqn = tableFqn(getDataset(id, admin));
  assert.notEqual(pushed[0].tables[fqn].visibility, 'public');
});

test('unshare back to My → a CLOSED entry is pushed for the table (never a stale public one)', async () => {
  const id = asset();
  await awaitDatasetPolicyPush(id); pushed = [];
  transition(id, admin, 'unshare');
  await awaitDatasetPolicyPush(id);
  const entries = Object.values(pushed[0].tables);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].visibility, 'private');
});

test('a failed push is TYPED and VISIBLE in the result (the tier change itself stands)', async () => {
  const id = asset();
  await awaitDatasetPolicyPush(id);
  failWith = 'OPA unreachable';
  const product = certify(id, admin, {});
  assert.equal(product.tier, 'product');
  const report = await policyPushReport(id);
  assert.equal(report.policyPush?.ok, false);
  assert.equal(report.policyPush && !report.policyPush.ok && report.policyPush.code, 'policy_push_failed');
  assert.match(report.warning ?? '', /could not be updated in the query engine/);
  assert.match(report.warning ?? '', /OPA unreachable/);
});

test('no tier change → no push; no port wired → no push and no report', async () => {
  const id = asset();
  await awaitDatasetPolicyPush(id); pushed = [];
  assert.equal(await awaitDatasetPolicyPush(id), null, 'consumed once');
  setDatasetPolicyPushPort(null);
  certify(id, admin, {});
  assert.deepEqual(await policyPushReport(id), {});
  assert.equal(pushed.length, 0);
});
