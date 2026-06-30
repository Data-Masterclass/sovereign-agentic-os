/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correlate } from './correlate.ts';
import { deriveScope } from './scope-core.ts';
import { allMockItems, SALES_OWNER } from './mock.ts';

const userSales = deriveScope('participant', SALES_OWNER, ['sales']);
const builderFinance = deriveScope('builder', 'b_fin', ['finance']);
const admin = deriveScope('admin', 'a_root', ['sales', 'finance', 'platform']);
const items = allMockItems();

test('correlation chain run→pipeline→system→artifact resolves from the failed run', () => {
  const c = correlate(userSales, 'run-2002', items);
  assert.ok(c, 'chain should resolve');
  assert.equal(c!.anchor, 'runs');
  assert.equal(c!.run?.id, 'run-2002');
  assert.equal(c!.pipeline?.id, 'pl-3001');
  assert.equal(c!.system?.id, 'sys-4001');
  assert.equal(c!.artifact?.id, 'art-6001');
});

test('cross-links surface the Governance audit entry + the cost cap', () => {
  const c = correlate(userSales, 'run-2002', items);
  assert.equal(c!.auditRef, 'audit-9007');
  assert.equal(c!.capRef, 'cap-sales-monthly');
});

test('correlation fans out from ANY anchor (pipeline → run + system + artifact)', () => {
  const c = correlate(admin, 'pl-3001', items);
  assert.ok(c);
  assert.equal(c!.anchor, 'pipelines');
  assert.equal(c!.run?.id, 'run-2002');
  assert.equal(c!.system?.id, 'sys-4001');
  assert.equal(c!.artifact?.id, 'art-6001');
});

test('SCOPE-SAFE: an out-of-scope viewer gets no chain (no correlation side-channel)', () => {
  // builder-finance cannot anchor on a sales run at all
  assert.equal(correlate(builderFinance, 'run-2002', items), null);
});

test('SCOPE-SAFE: hops outside scope are dropped, not leaked', () => {
  // Construct a chain where the run is the sales user's but the linked artifact
  // belongs to another owner — that hop must be elided for the user.
  const tampered = items.map((it) =>
    it.id === 'art-6001' ? { ...it, owner: 'someone_else' } : it,
  );
  const c = correlate(userSales, 'run-2002', tampered);
  assert.ok(c);
  assert.equal(c!.run?.id, 'run-2002');
  assert.equal(c!.artifact, undefined, 'foreign artifact hop must be dropped');
});

test('unknown anchor → null', () => {
  assert.equal(correlate(admin, 'does-not-exist', items), null);
});
