/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    "Index → Files" on a connected OneDrive (Connections tab) under the PRODUCTION
 *             posture (`OS_OFFLINE_MOCK=refuse`) — the connections half.
 * USER STORY: As a user who connected my OneDrive I want "Index → Files" to bring my real files
 *             into Files so that search and agents can use them.
 * ARCHITECTURE:
 * The bug: the button called `enableDataUsage`, which ran the Drive adapter's `sync` with NO
 * client injected — so production always refused it ("Cannot sync this Drive connection:
 * nothing was indexed …"), even after the owner's Microsoft consent. Now a personal OAuth drive
 * resolves the token the OAuth callback stored and hands it to the Files tab's live connector,
 * which the usage route injects (`indexDriveSource`; a tab never imports another tab). The Files
 * half — the real Microsoft Graph read — is `tabs/files/lib/drive-index-source.test.ts`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.OS_OFFLINE_MOCK = 'refuse'; // the production setting

const _realFetch = globalThis.fetch;
globalThis.fetch = ((u: unknown) => Promise.reject(new Error(`offline-stub: ${String(u)}`))) as typeof fetch;

const { createConnection, storeConnectionTokens, enableDataUsage, getConnectionForUser, __resetConnections } = await import('./store.ts');
type Indexer = NonNullable<Parameters<typeof enableDataUsage>[3]>['indexDrive'];
type IndexInput = Parameters<NonNullable<Indexer>>[0];

const REAL_TOKEN = 'EwB-test-real-graph-access-token';
const owner = { id: 'aborek', name: 'Alex', domains: ['sales'], role: 'admin' as const };
const nowSec = () => Math.floor(Date.now() / 1000);
let calls: IndexInput[] = [];
const indexDrive: Indexer = async (input) => { calls.push(input); return { sourceId: 'src_1', records: 2, mode: 'live' }; };

beforeEach(() => { __resetConnections(); calls = []; });

const makeOneDrive = () => createConnection(owner, { name: 'My OneDrive', template: 'onedrive', endpoint: '', credential: '' });
const consent = (connId: string) => storeConnectionTokens(connId, owner.id, { accessToken: REAL_TOKEN, refreshToken: 'r1', expiresAt: nowSec() + 3600 });

test('connected OneDrive: Index → Files hands the STORED token to the Files connector and records a live index', async () => {
  const conn = await makeOneDrive();
  await consent(conn.id);
  const updated = await enableDataUsage(conn.id, owner, 'files', { indexDrive });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { connectionId: conn.id, provider: 'onedrive', label: 'My OneDrive', owner: owner.id, domain: 'sales', token: REAL_TOKEN });
  assert.equal(updated.dataUsage, 'files');
  assert.equal(updated.dataUsageMode, 'live', 'a real sync is labelled live, never offline-mock');
});

test('twin: before consent there is no token — 409 with a Connect hint, the connector is never called, nothing marked', async () => {
  const conn = await makeOneDrive();
  await assert.rejects(enableDataUsage(conn.id, owner, 'files', { indexDrive }), (e: Error & { status?: number }) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /Connect your OneDrive first/);
    return true;
  });
  assert.equal(calls.length, 0);
  assert.equal((await getConnectionForUser(conn.id, owner)).dataUsage, null, 'no "Files index" badge without a real index');
});

test('twin: the provider refuses — the error surfaces and the connection is not marked indexed', async () => {
  const conn = await makeOneDrive();
  await consent(conn.id);
  const refusing: Indexer = async () => { throw new Error('Cannot sync onedrive: Microsoft Graph answered 403.'); };
  await assert.rejects(enableDataUsage(conn.id, owner, 'files', { indexDrive: refusing }), /Microsoft Graph answered 403/);
  assert.equal((await getConnectionForUser(conn.id, owner)).dataUsage, null);
});

test('twin: no indexer wired — an explicit error, never the fabricated adapter result', async () => {
  const conn = await makeOneDrive();
  await consent(conn.id);
  await assert.rejects(enableDataUsage(conn.id, owner, 'files'), (e: Error & { status?: number }) => e.status === 500 && /No Files indexer/.test(e.message));
  assert.equal((await getConnectionForUser(conn.id, owner)).dataUsage, null);
});

test("twin: another user (even an admin) cannot index someone else's personal OneDrive", async () => {
  const conn = await makeOneDrive();
  await consent(conn.id);
  const other = { id: 'someone-else', name: 'Other', domains: ['sales'], role: 'admin' as const };
  await assert.rejects(enableDataUsage(conn.id, other, 'files', { indexDrive }), (e: Error & { status?: number }) => e.status === 404 || e.status === 403);
  assert.equal(calls.length, 0);
});

test('restore real fetch', () => { globalThis.fetch = _realFetch; });
