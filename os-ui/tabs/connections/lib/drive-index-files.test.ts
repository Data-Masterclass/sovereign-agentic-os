/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * "Index → Files" on a connected OneDrive (Connections tab) under the PRODUCTION posture
 * (`OS_OFFLINE_MOCK=refuse`).
 *
 * The bug: the button called `enableDataUsage`, which ran the Drive adapter's `sync` with NO
 * client injected — so production always refused it ("Cannot sync this Drive connection:
 * nothing was indexed …"), even for a connection whose owner had completed the Microsoft
 * consent. The live OneDrive connector the Files tab already ships (`connectors-live.ts`,
 * Microsoft Graph `/me/drive/root/delta`) was never reached from the Connections tab.
 *
 * Microsoft Graph has no container we can run, so `fetch` answers ONLY Graph's documented
 * delta URL, and ONLY for the bearer the OAuth callback stored. Everything else is offline.
 * The twins below fail if the path stops calling Graph, invents a count, or indexes without
 * the owner's consent.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.OS_OFFLINE_MOCK = 'refuse'; // the production setting (values: OS_OFFLINE_MOCK=refuse)

const REAL_TOKEN = 'EwB-test-real-graph-access-token';
const GRAPH_DELTA = 'https://graph.microsoft.com/v1.0/me/drive/root/delta';
type GraphCall = { url: string; auth: string | null };
let graphCalls: GraphCall[] = [];
let graphStatus = 200;

const _realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url === GRAPH_DELTA) {
    const auth = new Headers(init?.headers).get('authorization');
    graphCalls.push({ url, auth });
    if (auth !== `Bearer ${REAL_TOKEN}`) return new Response('{"error":{"code":"InvalidAuthenticationToken"}}', { status: 401 });
    if (graphStatus !== 200) return new Response('{"error":{"code":"Forbidden"}}', { status: graphStatus });
    // The documented driveItem delta shape (https://learn.microsoft.com/graph/api/driveitem-delta).
    return Response.json({
      value: [
        { id: 'root-folder', name: 'root', folder: { childCount: 2 } },
        { id: '01ABC', name: 'Q3-board-pack.pdf', webUrl: 'https://contoso-my.sharepoint.com/q3.pdf', lastModifiedDateTime: '2026-11-19T10:00:00Z', file: { mimeType: 'application/pdf', hashes: { quickXorHash: 'qx1' } } },
        { id: '01DEF', name: 'pipeline.xlsx', webUrl: 'https://contoso-my.sharepoint.com/p.xlsx', lastModifiedDateTime: '2026-11-18T10:00:00Z', file: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', hashes: { quickXorHash: 'qx2' } } },
      ],
      '@odata.deltaLink': `${GRAPH_DELTA}?token=next`,
    });
  }
  throw new Error(`offline-stub: ${url}`);
}) as typeof fetch;

const { createConnection, storeConnectionTokens, enableDataUsage, getConnectionForUser, __resetConnections } = await import('./store.ts');
const { listSources, __resetConnectors } = await import('@tabs/files/lib/connectors');
const { listFiles, __resetStore } = await import('@tabs/files/lib/store');

const owner = { id: 'aborek', name: 'Alex', domains: ['sales'], role: 'admin' as const };
const nowSec = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  __resetConnections(); __resetConnectors(); __resetStore();
  graphCalls = []; graphStatus = 200;
});

async function makeOneDrive() {
  return createConnection(owner, { name: 'My OneDrive', template: 'onedrive', endpoint: '', credential: '' });
}
async function consent(connId: string) {
  // What the OAuth callback stores after the owner consents at login.microsoftonline.com.
  await storeConnectionTokens(connId, owner.id, { accessToken: REAL_TOKEN, refreshToken: 'r1', expiresAt: nowSec() + 3600 });
}
const driveFileNames = () => listFiles({ id: owner.id, domains: owner.domains, role: 'creator' }).mine
  .filter((f) => f.name === 'Q3-board-pack.pdf' || f.name === 'pipeline.xlsx').map((f) => f.name).sort();

test('connected OneDrive: Index → Files reads Microsoft Graph with the stored token and lands the real files', async () => {
  const conn = await makeOneDrive();
  await consent(conn.id);

  const updated = await enableDataUsage(conn.id, owner, 'files');

  assert.equal(graphCalls.length, 1, 'Microsoft Graph delta was called exactly once');
  assert.equal(graphCalls[0].auth, `Bearer ${REAL_TOKEN}`, 'with the token the OAuth callback stored');
  assert.equal(updated.dataUsage, 'files');
  assert.equal(updated.dataUsageMode, 'live', 'a real sync is labelled live, never offline-mock');
  const sources = listSources(owner.id);
  assert.equal(sources.length, 1, 'one Files source is registered for the connection');
  assert.equal(sources[0].provider, 'onedrive');
  assert.equal(sources[0].connectionId, conn.id, 'the source is LINKED to the governed connection (its token)');
  assert.equal(sources[0].initialDone, true);
  assert.deepEqual(driveFileNames(), ['Q3-board-pack.pdf', 'pipeline.xlsx'], 'exactly the files Graph returned (the folder is skipped)');
});

test('twin: before consent there is no token — refused with a Connect hint, Graph never called, nothing registered', async () => {
  const conn = await makeOneDrive();
  await assert.rejects(enableDataUsage(conn.id, owner, 'files'), (e: Error & { status?: number }) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /Connect/);
    return true;
  });
  assert.equal(graphCalls.length, 0);
  assert.equal(listSources(owner.id).length, 0);
  assert.equal((await getConnectionForUser(conn.id, owner)).dataUsage, null, 'no fabricated "Files index" badge');
});

test('twin: Graph refuses (403) — the error surfaces, no count is invented, the connection is not marked indexed', async () => {
  const conn = await makeOneDrive();
  await consent(conn.id);
  graphStatus = 403;
  await assert.rejects(enableDataUsage(conn.id, owner, 'files'), /Microsoft Graph answered 403/);
  assert.equal(graphCalls.length, 1, 'the live connector really called Graph');
  assert.deepEqual(driveFileNames(), []);
  assert.equal((await getConnectionForUser(conn.id, owner)).dataUsage, null);
});

test('twin: another user (even an admin) cannot index someone else\'s personal OneDrive', async () => {
  const conn = await makeOneDrive();
  await consent(conn.id);
  const other = { id: 'someone-else', name: 'Other', domains: ['sales'], role: 'admin' as const };
  await assert.rejects(enableDataUsage(conn.id, other, 'files'), (e: Error & { status?: number }) => e.status === 404 || e.status === 403);
  assert.equal(graphCalls.length, 0);
});

test('restore real fetch', () => { globalThis.fetch = _realFetch; });
