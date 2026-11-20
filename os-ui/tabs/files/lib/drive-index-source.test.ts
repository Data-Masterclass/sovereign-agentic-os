/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `indexDriveSource` — the Files half of the Connections "Index → Files" button for a
 *             connected OneDrive, under the PRODUCTION posture (`OS_OFFLINE_MOCK=refuse`).
 * USER STORY: As a user who connected my OneDrive I want my real drive files to land in Files
 *             so that search and agents can use them.
 * ARCHITECTURE:
 * Runs the real Files connector path (`connectors-live.ts` → `runSync` → store sink). Microsoft
 * Graph has no container we can run, so `fetch` answers ONLY Graph's documented delta URL
 * (https://learn.microsoft.com/graph/api/driveitem-delta) and ONLY for the bearer handed in;
 * everything else is offline. The twins fail if the path stops calling Graph, lands files Graph
 * did not return, or leaves a source behind after a refused first sync.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.OS_OFFLINE_MOCK = 'refuse';

const REAL_TOKEN = 'EwB-test-real-graph-access-token';
const GRAPH_DELTA = 'https://graph.microsoft.com/v1.0/me/drive/root/delta';
let graphCalls: { url: string; auth: string | null }[] = [];
let graphStatus = 200;

const _realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url === GRAPH_DELTA || url.startsWith(`${GRAPH_DELTA}?token=`)) {
    const auth = new Headers(init?.headers).get('authorization');
    graphCalls.push({ url, auth });
    if (auth !== `Bearer ${REAL_TOKEN}`) return new Response('{"error":{"code":"InvalidAuthenticationToken"}}', { status: 401 });
    if (graphStatus !== 200) return new Response('{"error":{"code":"accessDenied"}}', { status: graphStatus });
    // The saved @odata.deltaLink answers "no changes since" (an empty page).
    if (url !== GRAPH_DELTA) return Response.json({ value: [], '@odata.deltaLink': url });
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

const { indexDriveSource } = await import('./connectors-server.ts');
const { listSources, __resetConnectors } = await import('./connectors.ts');
const { listFiles, __resetStore } = await import('./store.ts');

const owner = { id: 'aborek', domains: ['sales'], role: 'creator' as const };
const input = { connectionId: 'conn_od1', provider: 'onedrive' as const, label: 'My OneDrive', owner: owner.id, domain: 'sales', token: REAL_TOKEN };
const driveFileNames = () => listFiles(owner).mine
  .filter((f) => f.name === 'Q3-board-pack.pdf' || f.name === 'pipeline.xlsx').map((f) => f.name).sort();

beforeEach(() => { __resetConnectors(); __resetStore(); graphCalls = []; graphStatus = 200; });

test('reads Microsoft Graph delta with the token and lands exactly the files Graph returned', async () => {
  const r = await indexDriveSource(input);
  assert.equal(graphCalls.length, 1);
  assert.equal(graphCalls[0].auth, `Bearer ${REAL_TOKEN}`);
  assert.equal(r.mode, 'live');
  assert.equal(r.records, 2, 'two files; the folder item is skipped');
  const sources = listSources(owner.id);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].connectionId, 'conn_od1', 'the source is LINKED to the governed connection');
  assert.equal(sources[0].scope, 'drive');
  assert.deepEqual(driveFileNames(), ['Q3-board-pack.pdf', 'pipeline.xlsx']);
});

test('a second Index reuses the linked source (no duplicate source)', async () => {
  const a = await indexDriveSource(input);
  graphCalls = [];
  const b = await indexDriveSource(input);
  assert.equal(b.sourceId, a.sourceId);
  assert.equal(graphCalls[0].url, `${GRAPH_DELTA}?token=next`, 'the incremental pass follows the saved deltaLink');
  assert.equal(listSources(owner.id).length, 1);
});

test('twin: Graph refuses (403) — the refusal propagates, no files land, no source is left behind', async () => {
  graphStatus = 403;
  await assert.rejects(indexDriveSource(input), /Microsoft Graph answered 403/);
  assert.equal(graphCalls.length, 1, 'Graph really was called');
  assert.deepEqual(driveFileNames(), []);
  assert.equal(listSources(owner.id).length, 0);
});

test('twin: a wrong token is refused by Graph (401) — nothing lands', async () => {
  await assert.rejects(indexDriveSource({ ...input, token: 'not-the-consented-token' }), /Microsoft Graph answered 401/);
  assert.deepEqual(driveFileNames(), []);
});

test('restore real fetch', () => { globalThis.fetch = _realFetch; });
