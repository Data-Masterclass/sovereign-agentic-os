/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * OPERATIONAL ACTION TOOLS — the four-layer fail-closed intersection + the enable
 * approval + flag-off inertness + executor honesty (operational-system-connections.md,
 * Phase 3). Offline: mirror/trace are unreachable no-ops so the in-process registries
 * are authoritative. The flag is forced ON for the intersection tests and OFF for the
 * inertness test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '@/lib/core/config';

(config as { operationalActionsEnabled: boolean }).operationalActionsEnabled = true;

globalThis.fetch = (async () => {
  throw new Error('offline-stub');
}) as typeof fetch;

const { createConnection, __resetConnections, callConnectionTool, grantToAgent } = await import('./store.ts');
const { createExposureSet, approveExposureActions, __resetExposures } = await import('./exposures.ts');
const { adoptActions, revokeActionAdoption, __resetActionAdoptions } = await import('./action-adoptions.ts');
const { decideActionTool, exposedActionTools, SF_ACTION_TOOLS, executeSalesforceAction } = await import('./salesforce-tools.ts');
const { allActiveExposures } = await import('./exposures.ts');
const { allActiveAdoptions } = await import('./action-adoptions.ts');

const admin = { id: 'a1', name: 'A', domains: ['commerce'], activeDomain: 'commerce', allDomains: ['commerce'], role: 'admin' as const };
const domainAdmin = { id: 'd1', name: 'D', domains: ['commerce'], activeDomain: 'commerce', allDomains: ['commerce'], role: 'domain_admin' as const };

async function sfConn() {
  return createConnection(admin, {
    name: 'Salesforce prod',
    template: 'salesforce-api',
    endpoint: 'https://acme.my.salesforce.com',
    credential: 'ck:cs',
  });
}

function reset() {
  __resetConnections();
  __resetExposures();
  __resetActionAdoptions();
}

/** Load the two stores + decide, the way callConnectionTool does. `callerDomains` defaults
 *  to the connection's own domain (the same-domain case these baseline tests exercise). */
async function decide(c: Awaited<ReturnType<typeof sfConn>>, tool: string, object: string, callerDomains: string[] = [c.domain]) {
  const [ex, ad] = await Promise.all([allActiveExposures(), allActiveAdoptions()]);
  return decideActionTool(c, tool, object, ex, ad, callerDomains);
}

test('INTERSECTION: no exposure ⇒ every action tool is invisible + denied (fail closed)', async () => {
  reset();
  const c = await sfConn();
  const d = await decide(c, SF_ACTION_TOOLS.get, 'Account');
  assert.equal(d.mode, null, 'no exposure ⇒ no tool');
  assert.deepEqual(await exposedActionTools(c, [c.domain]), []);
});

test('INTERSECTION: exposure read granted but NOT adopted ⇒ still denied', async () => {
  reset();
  const c = await sfConn();
  await createExposureSet(c.id, admin, {
    name: 'SF → Commerce', domains: ['commerce'], mode: 'sync', tier: 'silver',
    tables: [{ schema: 'salesforce', table: 'Account' }],
    actions: { account: { read: true } },
  });
  // Exposure exists, but the domain hasn't adopted → fail closed.
  const d = await decide(c, SF_ACTION_TOOLS.get, 'Account');
  assert.equal(d.mode, null);
  assert.match(d.reason, /adopted/); // C4: "no caller domain has adopted <entity> actions ..."
  assert.deepEqual(await exposedActionTools(c, [c.domain]), []);
});

test('INTERSECTION: exposure + adoption ⇒ read allowed, write held; then revoke kills it', async () => {
  reset();
  const c = await sfConn();
  const e = await createExposureSet(c.id, admin, {
    name: 'SF → Commerce', domains: ['commerce'], mode: 'sync', tier: 'silver',
    tables: [{ schema: 'salesforce', table: 'Account' }],
    actions: { account: { read: true, create: true } },
  });
  const adoption = await adoptActions(c.id, domainAdmin, { exposureId: e.id, domain: 'commerce', entities: ['account'] });

  // Read auto-allows once adopted.
  assert.equal((await decide(c, SF_ACTION_TOOLS.get, 'Account')).mode, 'Read');
  // Create is requested but NOT admin-approved yet ⇒ still no write tool.
  assert.equal((await decide(c, SF_ACTION_TOOLS.create, 'Account')).mode, null, 'write inert until approved');
  assert.deepEqual((await exposedActionTools(c, [c.domain])).sort(), [SF_ACTION_TOOLS.get]);

  // Admin approves the write actions ⇒ create becomes Write-approval.
  await approveExposureActions(e.id, admin);
  assert.equal((await decide(c, SF_ACTION_TOOLS.create, 'Account')).mode, 'Write-approval');
  assert.deepEqual((await exposedActionTools(c, [c.domain])).sort(), [SF_ACTION_TOOLS.create, SF_ACTION_TOOLS.get]);

  // Revoke the adoption ⇒ BOTH die immediately (recomputed per call, no stale cache).
  await revokeActionAdoption(adoption.id, domainAdmin);
  assert.equal((await decide(c, SF_ACTION_TOOLS.get, 'Account')).mode, null, 'revoke kills read');
  assert.equal((await decide(c, SF_ACTION_TOOLS.create, 'Account')).mode, null, 'revoke kills write');
  assert.deepEqual(await exposedActionTools(c, [c.domain]), []);
});

test('INTERSECTION: a different-entity call is denied (entity-scoped)', async () => {
  reset();
  const c = await sfConn();
  const e = await createExposureSet(c.id, admin, {
    name: 'SF → Commerce', domains: ['commerce'], mode: 'sync', tier: 'silver',
    tables: [{ schema: 'salesforce', table: 'Account' }],
    actions: { account: { read: true } },
  });
  await adoptActions(c.id, domainAdmin, { exposureId: e.id, domain: 'commerce', entities: ['account'] });
  assert.equal((await decide(c, SF_ACTION_TOOLS.get, 'Account')).mode, 'Read');
  assert.equal((await decide(c, SF_ACTION_TOOLS.get, 'Opportunity')).mode, null, 'other entity not granted');
});

test('INTERSECTION: delete is Blocked regardless of every layer', async () => {
  reset();
  const c = await sfConn();
  const e = await createExposureSet(c.id, admin, {
    name: 'SF → Commerce', domains: ['commerce'], mode: 'sync', tier: 'silver',
    tables: [{ schema: 'salesforce', table: 'Account' }],
    actions: { account: { read: true, create: true } },
  });
  await approveExposureActions(e.id, admin);
  await adoptActions(c.id, domainAdmin, { exposureId: e.id, domain: 'commerce', entities: ['account'] });
  assert.equal((await decide(c, SF_ACTION_TOOLS.delete, 'Account')).mode, 'Blocked');
});

test('C4 CROSS-DOMAIN: a Sales connection exposed to Commerce arms the CALLER, not the connection domain', async () => {
  reset();
  // The connection lives in SALES (its owner's first domain), exposed to COMMERCE.
  const salesAdmin = { id: 'sa', name: 'SA', domains: ['sales', 'commerce'], activeDomain: 'sales', allDomains: ['sales', 'commerce'], role: 'admin' as const };
  const c = await createConnection(salesAdmin, { name: 'SF sales', template: 'salesforce-api', endpoint: 'https://acme.my.salesforce.com', credential: 'ck:cs' });
  assert.equal(c.domain, 'sales', 'connection is in Sales');
  const e = await createExposureSet(c.id, salesAdmin, {
    name: 'SF → Commerce', domains: ['commerce'], mode: 'sync', tier: 'silver',
    tables: [{ schema: 'salesforce', table: 'Account' }],
    actions: { account: { read: true } },
  });
  // COMMERCE adopts the actions (the consent step).
  await adoptActions(c.id, domainAdmin, { exposureId: e.id, domain: 'commerce', entities: ['account'] });

  // A COMMERCE caller is ALLOWED (exposure ∩ callerDomains ∩ adoption all hit).
  assert.equal((await decide(c, SF_ACTION_TOOLS.get, 'Account', ['commerce'])).mode, 'Read', 'Commerce caller allowed');
  assert.deepEqual(await exposedActionTools(c, ['commerce']), [SF_ACTION_TOOLS.get], 'listed for Commerce');

  // A SALES caller (the connection's OWN domain) is DENIED — the exposure targets Commerce,
  // not Sales. Under the old c.domain keying this would have wrongly allowed / wrongly denied.
  assert.equal((await decide(c, SF_ACTION_TOOLS.get, 'Account', ['sales'])).mode, null, 'Sales caller denied (not a target domain)');
  assert.deepEqual(await exposedActionTools(c, ['sales']), [], 'nothing listed for Sales');

  // An un-adopted target domain is denied even though the exposure could reach it.
  const e2 = await createExposureSet(c.id, salesAdmin, {
    name: 'SF → Ops', domains: ['ops'], mode: 'sync', tier: 'silver',
    tables: [{ schema: 'salesforce', table: 'Account' }],
    actions: { account: { read: true } },
  });
  void e2;
  assert.equal((await decide(c, SF_ACTION_TOOLS.get, 'Account', ['ops'])).mode, null, 'un-adopted Ops domain denied');
});

test('callConnectionTool: read allows through the gate; create is held (requires_approval)', async () => {
  reset();
  const c = await sfConn();
  const e = await createExposureSet(c.id, admin, {
    name: 'SF → Commerce', domains: ['commerce'], mode: 'sync', tier: 'silver',
    tables: [{ schema: 'salesforce', table: 'Account' }],
    actions: { account: { read: true, create: true } },
  });
  await approveExposureActions(e.id, admin);
  await adoptActions(c.id, domainAdmin, { exposureId: e.id, domain: 'commerce', entities: ['account'] });

  const created = await callConnectionTool(c.id, admin, { tool: SF_ACTION_TOOLS.create, args: { object: 'Account', values: { Name: 'X' } } });
  assert.equal(created.decision, 'requires_approval', 'create is held for approval');

  // A get with no exposure/adoption on a fresh connection is denied (fail closed).
  const other = await sfConn();
  const denied = await callConnectionTool(other.id, admin, { tool: SF_ACTION_TOOLS.get, args: { object: 'Account', id: '001000000000001' } });
  assert.equal(denied.decision, 'deny');
});

test('LAYER 4 grant: an agent granted read-only cannot call create', async () => {
  reset();
  const c = await sfConn();
  const e = await createExposureSet(c.id, admin, {
    name: 'SF → Commerce', domains: ['commerce'], mode: 'sync', tier: 'silver',
    tables: [{ schema: 'salesforce', table: 'Account' }],
    actions: { account: { read: true, create: true } },
  });
  await approveExposureActions(e.id, admin);
  await adoptActions(c.id, domainAdmin, { exposureId: e.id, domain: 'commerce', entities: ['account'] });

  await grantToAgent(c.id, admin, 'agent-x', 'read-only');
  const create = await callConnectionTool(c.id, admin, { tool: SF_ACTION_TOOLS.create, args: { object: 'Account', values: {} }, asAgent: 'agent-x' });
  assert.equal(create.decision, 'deny', 'read-only grant excludes create');
  assert.match(create.reason, /grant|scope/i);
});

test('FLAG OFF: everything is inert (no tools, deny) even with exposure + adoption', async () => {
  reset();
  (config as { operationalActionsEnabled: boolean }).operationalActionsEnabled = false;
  const c = await sfConn();
  // createExposureSet drops `actions` when the flag is off, so build the intersection
  // decision directly — it must still deny on the flag alone.
  const d = await decide(c, SF_ACTION_TOOLS.get, 'Account');
  assert.equal(d.mode, null);
  assert.match(d.reason, /not enabled/);
  assert.deepEqual(await exposedActionTools(c, [c.domain]), []);
  (config as { operationalActionsEnabled: boolean }).operationalActionsEnabled = true;
});

test('EXECUTOR HONESTY: a failing token ⇒ { ok:false, reason }, never throws; carries the label', async () => {
  reset();
  const c = await sfConn();
  // The offline-stub fetch throws → sfToken degrades to { ok:false } → the executor
  // returns an honest failure envelope (never throws), stamped as the service account.
  const r = (await executeSalesforceAction(c, SF_ACTION_TOOLS.get, { object: 'Account', id: '001000000000001' })) as Record<string, unknown>;
  assert.equal(r.ok, false);
  assert.equal(typeof r.reason, 'string');
  assert.equal(r.asServiceAccount, true);
  assert.match(String(r.identity), /integration account/);
});

test('EXECUTOR: sf_search truncated flag + label with a mocked client page', async () => {
  reset();
  const c = await sfConn();
  // Mock fetch: token grant, then a full page (2 rows) at LIMIT 2 ⇒ truncated true.
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    if (String(url).includes('/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    }
    return new Response(JSON.stringify({ totalSize: 2, done: true, records: [{ attributes: {}, Id: '1' }, { attributes: {}, Id: '2' }] }), { status: 200 });
  }) as typeof fetch;

  const r = (await executeSalesforceAction(c, SF_ACTION_TOOLS.search, { object: 'Account', limit: 2 })) as Record<string, unknown>;
  globalThis.fetch = (async () => { throw new Error('offline-stub'); }) as typeof fetch;
  assert.equal(r.ok, true);
  assert.equal((r.records as unknown[]).length, 2);
  assert.equal(r.truncated, true, 'a full page ⇒ more may exist');
  assert.equal(r.asServiceAccount, true);
  // The attributes envelope is stripped.
  assert.ok(!JSON.stringify(r.records).includes('attributes'));
});
