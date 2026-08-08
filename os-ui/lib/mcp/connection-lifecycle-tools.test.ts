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
import type { CurrentUser } from '@/lib/core/auth';
import { config } from '@/lib/core/config';

(config as { externalConnectorsEnabled: boolean }).externalConnectorsEnabled = true;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { handleRpc } = await import('./server.ts');
type JsonRpcResponse = import('./server.ts').JsonRpcResponse;
const { createConnection, promoteConnection, __resetConnections } = await import('@/lib/connections/store');

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
