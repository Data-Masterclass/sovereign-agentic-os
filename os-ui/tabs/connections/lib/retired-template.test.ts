/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    A stored connection on a retired template (the pasted-token Outlook) degrades honestly
 * USER STORY: As an admin with an old connection on a removed template I want a plain "this connector was
 *             retired, use …" — never a crash and never a mock answer that looks like a real one.
 * ARCHITECTURE: the real store; the record's template is set to the retired key in place, as a mirror
 *   hydration of an old record would leave it. Test, call and data-usage each refuse with the reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retiredTemplateReason, isUserFacingTemplate, templateByKey } from './schema.ts';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const store = await import('./store.ts');

const admin = { id: 'a1', name: 'Admin', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'admin' as const };

test('outlook is retired: no template, not user-facing, a plain reason pointing to Microsoft 365', () => {
  assert.equal(templateByKey('outlook'), undefined);
  assert.equal(isUserFacingTemplate('outlook'), false);
  assert.match(retiredTemplateReason('outlook')!, /Microsoft 365 account connection/);
  assert.equal(retiredTemplateReason('teams'), null);
});

test('a stored outlook connection is refused by test, call and data-usage — never run through the mock', async () => {
  store.__resetConnections();
  const c = await store.createConnection(admin, { name: 'old mail', template: 'teams', endpoint: '', credential: 'eyJsecret-graph-1234567890' });
  const live = (await store.listConnectionsForUser(admin)).find((x) => x.id === c.id)!;
  (live as { template: string }).template = 'outlook';
  const t = await store.testConnection(c.id, admin);
  assert.equal(t.ok, false);
  assert.match(t.detail, /retired/);
  const call = await store.callConnectionTool(c.id, admin, { tool: 'list_teams' });
  assert.equal(call.decision, 'deny');
  assert.match(call.reason, /retired/);
  await assert.rejects(store.enableDataUsage(c.id, admin, 'bronze'), /retired/);
});
