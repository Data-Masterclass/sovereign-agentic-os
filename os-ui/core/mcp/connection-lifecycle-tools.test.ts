/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * m3 — MCP lifecycle twins for Connections, driven over handleRpc exactly as an AI client
 * would, against the REAL governed store. They must run the SAME lib (and gates) as the UI:
 *   • retire_connection archive/unarchive/delete (edit-scoped);
 *   • configure_connection rename/move/demote/capabilities (demote+capabilities Builder+);
 *   • revoke_action_adoption floors at domain_admin.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';

(config as { externalConnectorsEnabled: boolean }).externalConnectorsEnabled = true;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { handleRpc } = await import('./server.ts');
type JsonRpcResponse = import('./server.ts').JsonRpcResponse;
const { createConnection, promoteConnection, __resetConnections } = await import('@tabs/connections/lib/store');

const admin: CurrentUser = { id: 'ada', name: 'Ada', domains: ['sales'], role: 'admin' };
const domainAdmin: CurrentUser = { id: 'dan', name: 'Dan', domains: ['sales'], role: 'domain_admin' };
const creator: CurrentUser = { id: 'cor', name: 'Cor', domains: ['sales'], role: 'creator' };

async function call(user: CurrentUser, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res && 'result' in res, `expected a result for ${name}`);
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}
function payload<T = Record<string, unknown>>(r: Record<string, unknown>): T {
  assert.notEqual(r.isError, true, `expected success, got: ${(r.content as { text: string }[])?.[0]?.text}`);
  return JSON.parse((r.content as { text: string }[])[0].text) as T;
}
function errorText(r: Record<string, unknown>): string {
  assert.equal(r.isError, true, 'expected a typed tool error');
  return (r.content as { text: string }[])[0].text;
}

beforeEach(() => { __resetConnections(); });

test('m3 retire_connection: archive then unarchive (edit-scoped)', async () => {
  const c = await createConnection(admin, { name: 'DB', template: 'database', endpoint: '', credential: 'pw' });
  const arch = payload<{ archived: boolean }>(await call(admin, 'retire_connection', { connId: c.id, mode: 'archive' }));
  assert.equal(arch.archived, true);
  const un = payload<{ archived: boolean }>(await call(admin, 'retire_connection', { connId: c.id, mode: 'unarchive' }));
  assert.equal(un.archived, false);
});

test('m3 retire_connection delete: physical teardown report', async () => {
  const c = await createConnection(admin, { name: 'DB', template: 'database', endpoint: '', credential: 'pw' });
  const del = payload<{ deleted: boolean }>(await call(admin, 'retire_connection', { connId: c.id, mode: 'delete' }));
  assert.equal(del.deleted, true);
});

test('m3 configure_connection rename', async () => {
  const c = await createConnection(admin, { name: 'DB', template: 'database', endpoint: '', credential: 'pw' });
  const r = payload<{ name: string }>(await call(admin, 'configure_connection', { connId: c.id, action: 'rename', name: 'Renamed DB' }));
  assert.equal(r.name, 'Renamed DB');
});

test('m3 configure_connection capabilities: a creator is refused (edit-scope + Builder+ floor)', async () => {
  const c = await createConnection(admin, { name: 'MCP', template: 'generic-mcp', endpoint: 'https://mcp.example.com/sse', credential: 'tok' });
  // A creator neither owns nor meets the Builder floor — refused in-lib.
  const err = errorText(await call(creator, 'configure_connection', { connId: c.id, action: 'capabilities', capabilities: [{ name: 'search', mode: 'Read' }] }));
  assert.match(err, /not permitted|Builder|Administrator|not found/i);
});

test('m3 configure_connection demote: lowers one tier', async () => {
  const c = await createConnection(admin, { name: 'DB', template: 'database', endpoint: '', credential: 'pw' });
  await promoteConnection(c.id, domainAdmin); // Personal → Shared
  const r = payload<{ visibility: string }>(await call(admin, 'configure_connection', { connId: c.id, action: 'demote' }));
  assert.equal(r.visibility, 'Personal');
});

test('m3 revoke_action_adoption: floors at domain_admin (a creator is refused)', async () => {
  // No such adoption id — but the ROLE gate is checked first, so a creator is refused
  // before the lookup (minRole domain_admin on the tool).
  const res = await handleRpc(creator, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'revoke_action_adoption', arguments: { adoptionId: 'x' } } });
  const r = (res as JsonRpcResponse).result as Record<string, unknown>;
  assert.equal(r.isError, true, 'creator is refused revoke_action_adoption');
});

// ---- THE AGENT WRITE POSTURE BINDS AGENTS ONLY (2026-11-19) ----------------------------------
//
// `revoke_action_adoption` is closed to agent runs (`AGENT_FORBIDDEN_TOOLS`) and `retire_connection`
// is held for a second person when an AGENT calls it (`hold.ts`). Neither rule may reach a signed-in
// person: `/api/mcp` → `serveMcp` → `handleRpc` is this exact call, and it consults no agent table.
// The retire/configure tests above already show a person's call executing directly; this is the
// same proof for the one tool that is now refused to agents outright.

test('a PERSON is not refused revoke_action_adoption by the agent-forbidden gate: the call reaches the governed lib', async () => {
  const { agentForbiddenReason } = await import('./write-tool-meta.ts');
  const agentReason = agentForbiddenReason('revoke_action_adoption');
  assert.ok(agentReason, 'precondition: the tool IS closed to agent runs');
  for (const person of [domainAdmin, admin]) {
    const r = await call(person, 'revoke_action_adoption', { adoptionId: 'ad_does_not_exist' });
    // It fails — there is no such adoption — but with the LIB's own answer, which is only
    // reachable past the role floor and inside the tool body. An agent-door refusal would carry
    // the catalog's reason and `forbidden` instead.
    const text = errorText(r);
    assert.match(text, /Adoption not found/, `${person.role}: the governed lib answered`);
    assert.doesNotMatch(text, /not an agent action/, `${person.role}: not the agent-door refusal`);
    assert.ok(!text.includes(agentReason!), `${person.role}: not the catalog's agent reason`);
    assert.notEqual((JSON.parse(text) as { error: { code: string } }).error.code, 'forbidden');
  }
});

test('a PERSON is not HELD on retire_connection: no approval is filed, the connection is archived at once', async () => {
  const { listApprovals } = await import('@core/policy/approvals');
  const before = listApprovals().length;
  const c = await createConnection(domainAdmin, { name: 'DB', template: 'database', endpoint: '', credential: 'pw' });
  const arch = payload<{ archived: boolean }>(await call(domainAdmin, 'retire_connection', { connId: c.id, mode: 'archive' }));
  assert.equal(arch.archived, true, 'executed directly, as the person');
  assert.equal(listApprovals().length, before, 'nothing was parked in the Governance inbox');
});

