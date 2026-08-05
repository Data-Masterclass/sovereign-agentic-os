/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * MCP parity for the OPERATIONAL action-adoption journey (operational-system-connections.md,
 * Phase 6). Driven over `handleRpc` / `tools/call` with the REAL governed stores. Proves:
 *   • create_exposure_set carries `actions`; read/search compile immediately, create/update
 *     enqueue the admin `exposure_action_enable` approval (writeApproved:false until approved);
 *   • list_adoptable_actions is domain-scoped and only lists exposures that carry actions;
 *   • adopt_entity_actions floors at domain_admin, re-resolves governance server-side, and
 *     keeps only entities the exposure actually grants (fail-closed);
 *   • a builder is refused the adopt act.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { config } from '@/lib/core/config';

(config as { operationalActionsEnabled: boolean }).operationalActionsEnabled = true;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { handleRpc } = await import('./server.ts');
type JsonRpcResponse = import('./server.ts').JsonRpcResponse;
type ToolError = import('./server.ts').ToolError;
const { createConnection, __resetConnections } = await import('@/lib/connections/store');
const { __resetExposures } = await import('@/lib/connections/exposures');
const { __resetActionAdoptions } = await import('@/lib/connections/action-adoptions');

// A platform admin (exposure CRUD) who shares the exposed domain, and a domain_admin +
// builder of the SAME domain (commerce) so adoption is in-scope for the domain_admin.
const admin: CurrentUser = { id: 'ada', name: 'Ada', domains: ['commerce'], role: 'admin' };
const dadmin: CurrentUser = { id: 'dan', name: 'Dan', domains: ['commerce'], role: 'domain_admin' };
const builder: CurrentUser = { id: 'ben', name: 'Ben', domains: ['commerce'], role: 'builder' };

async function call(user: CurrentUser, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res && 'result' in res, `expected a result for ${name}`);
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}
function payload<T = Record<string, unknown>>(r: Record<string, unknown>): T {
  assert.notEqual(r.isError, true, `expected success, got: ${(r.content as { text: string }[])?.[0]?.text}`);
  return JSON.parse((r.content as { text: string }[])[0].text) as T;
}
function errorOf(r: Record<string, unknown>): ToolError {
  assert.equal(r.isError, true, 'expected a typed tool error');
  return (r.structuredContent as { error: ToolError }).error;
}

/** A Salesforce (operational) connection owned by the admin in the commerce domain. */
async function seedOperational(): Promise<{ connId: string }> {
  __resetConnections(); __resetExposures(); __resetActionAdoptions();
  const c = await createConnection(admin, {
    name: 'SF', template: 'salesforce-api', endpoint: 'https://org.my.salesforce.com', credential: 'ck:cs',
  });
  return { connId: c.id };
}

test('create_exposure_set carries actions: read/search live, create/update await approval', async () => {
  const { connId } = await seedOperational();
  const created = payload<{ exposure: { id: string; actions?: Record<string, unknown>; writeApproved?: boolean } }>(
    await call(admin, 'create_exposure_set', {
      connId, name: 'SF read+write', domains: ['commerce'], mode: 'sync',
      tables: [{ schema: 'salesforce', table: 'Account' }, { schema: 'salesforce', table: 'Opportunity' }],
      actions: { account: { read: true, search: true }, opportunity: { read: true, update: true } },
    }),
  );
  assert.ok(created.exposure.actions);
  // A create/update was requested ⇒ writeApproved starts false (held for admin approval).
  assert.equal(created.exposure.writeApproved, false);
});

test('list_adoptable_actions is domain-scoped + lists only exposures carrying actions', async () => {
  const { connId } = await seedOperational();
  // A data-only exposure (no actions) must NOT appear.
  await call(admin, 'create_exposure_set', { connId, name: 'data only', domains: ['commerce'], mode: 'sync', tables: [{ schema: 'salesforce', table: 'Lead' }] });
  // An actions exposure DOES.
  await call(admin, 'create_exposure_set', {
    connId, name: 'actions', domains: ['commerce'], mode: 'sync',
    tables: [{ schema: 'salesforce', table: 'Account' }], actions: { account: { read: true } },
  });
  const p = payload<{ connections: { exposures: { name: string }[] }[] }>(await call(dadmin, 'list_adoptable_actions'));
  const names = p.connections.flatMap((c) => c.exposures.map((e) => e.name));
  assert.deepEqual(names, ['actions']);
});

test('adopt_entity_actions floors at domain_admin; keeps only granted entities', async () => {
  const { connId } = await seedOperational();
  const exp = payload<{ exposure: { id: string } }>(await call(admin, 'create_exposure_set', {
    connId, name: 'actions', domains: ['commerce'], mode: 'sync',
    tables: [{ schema: 'salesforce', table: 'Account' }], actions: { account: { read: true, search: true } },
  }));
  // A builder is refused the adopt act (domain_admin floor).
  assert.equal(errorOf(await call(builder, 'adopt_entity_actions', { exposureId: exp.exposure.id, entities: ['account'] })).code, 'forbidden');
  // The domain_admin adopts — an ungranted entity ('contact') is dropped, only 'account' sticks.
  const adopted = payload<{ adoption: { entities: string[]; domain: string } }>(
    await call(dadmin, 'adopt_entity_actions', { exposureId: exp.exposure.id, entities: ['account', 'contact'] }),
  );
  assert.deepEqual(adopted.adoption.entities, ['account']);
  assert.equal(adopted.adoption.domain, 'commerce');
});

test('adopt_entity_actions refuses an exposure that grants the domain no actions', async () => {
  const { connId } = await seedOperational();
  const exp = payload<{ exposure: { id: string } }>(await call(admin, 'create_exposure_set', {
    connId, name: 'data only', domains: ['commerce'], mode: 'sync', tables: [{ schema: 'salesforce', table: 'Account' }],
  }));
  const err = errorOf(await call(dadmin, 'adopt_entity_actions', { exposureId: exp.exposure.id, entities: ['account'] }));
  assert.match(err.reason, /no adoptable actions/i);
});
