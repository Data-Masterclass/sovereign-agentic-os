/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Operational registry (operational-system-connections.md, Phase 0) — the registry that
 * replaces the hardcoded `liveApiPlatform` switch and carries cursor honesty. Pure: no
 * network, no secrets (the slice runners are lazy and never reached here).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  platformForTemplate,
  isOperationalTemplate,
  operationalTemplates,
  operationalEntry,
  cursorSupportFor,
  pullOperationalSlice,
} from './operational-registry.ts';

test('platformForTemplate: byte-parity with the prior salesforce|kajabi switch', () => {
  assert.equal(platformForTemplate('kajabi-api'), 'kajabi');
  assert.equal(platformForTemplate('salesforce-api'), 'salesforce');
  // Unknown / non-operational template → 'salesforce' (the prior switch's default, so the
  // Salesforce slice runner surfaces the honest "not an available sync source" error).
  assert.equal(platformForTemplate('warehouse'), 'salesforce');
  assert.equal(platformForTemplate('github'), 'salesforce');
});

test('isOperationalTemplate / operationalTemplates only cover the api-batch sources', () => {
  assert.equal(isOperationalTemplate('salesforce-api'), true);
  assert.equal(isOperationalTemplate('kajabi-api'), true);
  assert.equal(isOperationalTemplate('sap-odata'), true);
  assert.equal(isOperationalTemplate('odata-v4'), true);
  assert.equal(isOperationalTemplate('workday-raas'), true);
  assert.equal(isOperationalTemplate('warehouse'), false);
  assert.deepEqual(operationalTemplates().sort(), ['kajabi-api', 'odata-v4', 'salesforce-api', 'sap-odata', 'workday-raas']);
});

test('cursorSupportFor: Salesforce is honest true-incremental on SystemModstamp', () => {
  const s = cursorSupportFor('salesforce-api', 'Account');
  assert.ok(s);
  assert.equal(s!.incremental, true);
  assert.equal(s!.cursorColumn, 'SystemModstamp');
  assert.equal(s!.chip, 'Incremental (SystemModstamp)');
});

test('cursorSupportFor: Kajabi honesty is verbatim from kajabi-resources', () => {
  // purchases documents sort=updated_at → true incremental.
  assert.equal(cursorSupportFor('kajabi-api', 'purchases')!.chip, 'Incremental (updated_at)');
  assert.equal(cursorSupportFor('kajabi-api', 'purchases')!.cursorColumn, 'updated_at');
  // contacts documents created_at only → append-only, edits not detected.
  assert.equal(cursorSupportFor('kajabi-api', 'contacts')!.chip, 'Incremental (created_at)');
  // offers carry no timestamps → full refresh only.
  const offers = cursorSupportFor('kajabi-api', 'offers')!;
  assert.equal(offers.incremental, false);
  assert.equal(offers.cursorColumn, null);
  assert.equal(offers.chip, 'Full refresh only');
});

test('cursorSupportFor: a non-operational template has no cursor answer', () => {
  assert.equal(cursorSupportFor('warehouse', 'anything'), null);
});

test('operationalEntry exposes discover + cursorFor per template', () => {
  const sf = operationalEntry('salesforce-api');
  assert.ok(sf);
  assert.equal(sf!.platform, 'salesforce');
  assert.equal(typeof sf!.discover, 'function');
  assert.equal(sf!.cursorFor('Account').cursorColumn, 'SystemModstamp');
  assert.equal(operationalEntry('warehouse'), undefined);
});

test('pullOperationalSlice dispatches to the injected platform runner, byte-identical args', async () => {
  const common = { connectionId: 'c1', foo: 'bar' } as never;
  let sfArg: unknown = null;
  let kjArg: unknown = null;
  const deps = {
    salesforceSlice: async (a: unknown) => { sfArg = a; return { rowsAffected: 1, highWatermark: null }; },
    kajabiSlice: async (a: unknown) => { kjArg = a; return { rowsAffected: 2, highWatermark: null }; },
  };

  const sf = await pullOperationalSlice('salesforce', common, 'Account', deps);
  assert.equal(sf.rowsAffected, 1);
  assert.deepEqual(sfArg, { connectionId: 'c1', foo: 'bar', object: 'Account' });
  assert.equal(kjArg, null);

  const kj = await pullOperationalSlice('kajabi', common, 'purchases', deps);
  assert.equal(kj.rowsAffected, 2);
  assert.deepEqual(kjArg, { connectionId: 'c1', foo: 'bar', resource: 'purchases' });
});
