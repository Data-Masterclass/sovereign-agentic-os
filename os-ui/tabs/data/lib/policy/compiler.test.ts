/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePolicy, evaluateOpa, governanceFor, tableFqn, type Roster } from '@tabs/data/lib/policy/compiler';
import { emptyVersions, type Dataset, type Grant } from '@tabs/data/lib/dataset-schema';

function product(over: Partial<Dataset> = {}): Dataset {
  const v = emptyVersions();
  v.bronze.built = true; v.silver.built = true; v.gold.built = true;
  return {
    version: '1', id: 'ds_orders', name: 'Orders', owner: 'amir', domain: 'sales',
    tier: 'product', visibility: 'shared', description: 'Orders.', versions: v,
    grants: [], measures: [], columns: [{ name: 'order_id', description: 'k' }, { name: 'net_amount', description: 'v' }],
    ...over,
  };
}

const roster: Roster = {
  amir: { domains: ['sales'] },
  kenji: { domains: ['finance'] },
  sam: { domains: ['sales', 'finance'] },
};

const domainGrant = (id: string): Grant => ({ grantee: { kind: 'domain', id }, scope: { rows: [], columns: { mask: [], hide: [] } }, cardinality: 'low', action: 'read' });
const userGrant = (id: string): Grant => ({ grantee: { kind: 'user', id }, scope: { rows: [], columns: { mask: [], hide: [] } }, cardinality: 'low', action: 'read' });
const maskGrant = (col: string): Grant => ({ grantee: { kind: 'domain', id: 'sales' }, scope: { rows: [], columns: { mask: [col], hide: [] } }, cardinality: 'low', action: 'read' });

test('compiles ONE source → the OPA governance bundle the trino rego reads', () => {
  const d = product({ imports: ['finance'], grants: [userGrant('analyst1')] });
  const { opa } = compilePolicy([d], roster);
  const fqn = tableFqn(d);
  assert.equal(opa.tables[fqn].domain, 'sales');
  assert.equal(opa.tables[fqn].visibility, 'shared');
  assert.deepEqual(opa.tables[fqn].shared_with, ['finance']); // import = domain read grant
  assert.deepEqual(opa.tables[fqn].shared_with_users, ['analyst1']);
  assert.deepEqual(opa.principals.kenji, { domains: ['finance'], clearances: [] });
});

test('emits a domain SELF-PRINCIPAL for every governing/shared domain (empty-scorecard guard)', () => {
  // The governed query tool runs AS the domain name; without a self-map the row
  // filter resolves membership to [] → 0 rows. The roster here lists only USERS
  // (no 'sales'/'finance' keys), so these must come from the self-emit.
  const d = product({ imports: ['finance'] }); // domain 'sales', shared_with ['finance']
  const { opa } = compilePolicy([d], roster);
  assert.deepEqual(opa.principals.sales, { domains: ['sales'], clearances: [] });
  assert.deepEqual(opa.principals.finance, { domains: ['finance'], clearances: [] });
  // A real roster entry is never clobbered by the self-emit.
  assert.deepEqual(opa.principals.sam, { domains: ['sales', 'finance'], clearances: [] });
});

test('restricted column: masked in Trino for a principal without clearance', () => {
  const d = product({ grants: [maskGrant('net_amount')] });
  const { opa } = compilePolicy([d], roster);
  const fqn = tableFqn(d);
  const opaDec = evaluateOpa(opa, { user: 'amir', domains: ['sales'] }, fqn, 'net_amount');
  assert.equal(opaDec.entitled, true);
  assert.equal(opaDec.masked, true);
});

test('cross-domain without a grant is denied', () => {
  const d = product({ visibility: 'domain' }); // sales only, no finance grant
  const { opa } = compilePolicy([d], roster);
  assert.equal(evaluateOpa(opa, { user: 'kenji', domains: ['finance'] }, tableFqn(d)).entitled, false);
});

test('a shared import entitles the importing domain (the marketplace grant)', () => {
  const d = product({ imports: ['finance'] });
  const { opa } = compilePolicy([d], roster);
  assert.equal(evaluateOpa(opa, { user: 'kenji', domains: ['finance'] }, tableFqn(d)).entitled, true);
  assert.equal(evaluateOpa(opa, { user: 'zoe', domains: ['marketing'] }, tableFqn(d)).entitled, false);
});

test('private datasets are not governed in Trino (no table entry)', () => {
  assert.equal(governanceFor(product({ tier: 'dataset', visibility: 'private' })), null);
});

test('domain-visibility with a stray cross-domain domain grant still denies (shared_with gated on visibility=shared)', () => {
  const d = product({ tier: 'asset', visibility: 'domain', grants: [domainGrant('finance')] });
  const { opa } = compilePolicy([d], roster);
  assert.equal(evaluateOpa(opa, { user: 'kenji', domains: ['finance'] }, tableFqn(d)).entitled, false);
});
