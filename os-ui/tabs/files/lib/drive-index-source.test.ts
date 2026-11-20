/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `indexDriveSource` — the Files half of the Connections "Index → Files" button for a
 *             connected OneDrive, under the PRODUCTION posture (`OS_OFFLINE_MOCK=refuse`).
 * USER STORY: As a user who connected my OneDrive I want my real drive files to land in Files
 *             so that search and agents can use them.
 * ARCHITECTURE:
 * Runs the real Files connector path (`connectors-live.ts` → `runSync` → store sink → the upload
 * pipeline). Microsoft Graph has no container we can run, so `fetch` answers ONLY Graph's
 * documented delta and content URLs (driveitem-delta, driveitem-get-content — the content's 302
 * to the pre-authenticated download URL is fetch's own redirect handling, so the stub answers
 * the followed result) and ONLY for the bearer handed in; everything else is offline. The twins fail if the path stops calling Graph, lands files Graph
 * did not return, or leaves a source behind after a refused first sync.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCluster } from '@core/infra/two-process-fixture';

process.env.OS_OFFLINE_MOCK = 'refuse';

const REAL_TOKEN = 'EwB-test-real-graph-access-token';
const GRAPH = 'https://graph.microsoft.com/v1.0/me/drive';
const GRAPH_DELTA = `${GRAPH}/root/delta`;
const NOTES = '# Pipeline review\nThe Nordic pipeline closes 4.2M EUR in Q4.';
const PDF = Buffer.from('%PDF-1.4\n% a tiny pdf body\n');
let graphCalls: { url: string; auth: string | null }[] = [];
let graphStatus = 200;
let contentStatus: Record<string, number> = {};

const _realFetch = globalThis.fetch;
// A FRESH fake OpenSearch per test (the stores' mirror — the sources must load), with Graph in front.
let cluster: ReturnType<typeof fakeCluster> | null = null;
let clusterFetch: typeof fetch = _realFetch;
function freshNetwork() {
  cluster?.restore();
  cluster = fakeCluster();
  clusterFetch = globalThis.fetch;
  globalThis.fetch = graphFetch;
}
const graphFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith(GRAPH)) return clusterFetch(input, init);
  const auth = new Headers(init?.headers).get('authorization');
  graphCalls.push({ url, auth });
  if (auth !== `Bearer ${REAL_TOKEN}`) return new Response('{"error":{"code":"InvalidAuthenticationToken"}}', { status: 401 });
  const content = url.match(/\/items\/([^/]+)\/content$/);
  if (content) {
    const st = contentStatus[content[1]] ?? 200;
    if (st !== 200) return new Response('{"error":{"code":"accessDenied"}}', { status: st });
    if (content[1] === '01DEF') return new Response(NOTES, { headers: { 'content-type': 'text/markdown' } });
    if (content[1] === '01ABC') return new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
    return new Response('{"error":{"code":"itemNotFound"}}', { status: 404 });
  }
  if (url === GRAPH_DELTA || url.startsWith(`${GRAPH_DELTA}?token=`)) {
    if (graphStatus !== 200) return new Response('{"error":{"code":"accessDenied"}}', { status: graphStatus });
    // The saved @odata.deltaLink answers "no changes since" (an empty page).
    if (url !== GRAPH_DELTA) return Response.json({ value: [], '@odata.deltaLink': url });
    return Response.json({
      value: [
        { id: 'root-folder', name: 'root', folder: { childCount: 2 } },
        { id: '01ABC', name: 'Q3-board-pack.pdf', webUrl: 'https://contoso-my.sharepoint.com/q3.pdf', lastModifiedDateTime: '2026-11-19T10:00:00Z', file: { mimeType: 'application/pdf', hashes: { quickXorHash: 'qx1' } } },
        { id: '01DEF', name: 'pipeline-notes.md', webUrl: 'https://contoso-my.sharepoint.com/p.md', lastModifiedDateTime: '2026-11-18T10:00:00Z', file: { mimeType: 'text/markdown', hashes: { quickXorHash: 'qx2' } } },
      ],
      '@odata.deltaLink': `${GRAPH_DELTA}?token=next`,
    });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;
freshNetwork();

const { indexDriveSource } = await import('./connectors-server.ts');
const { listSources, getSource, __resetConnectors } = await import('./connectors.ts');
const { listFiles, getFile, objectKeyForAsset, __resetStore } = await import('./store.ts');
const { getBlob, __resetBlobs } = await import('./object-store.ts');

const owner = { id: 'aborek', domains: ['sales'], role: 'creator' as const };
const liveOwner = async (id: string) => (id === owner.id ? { domains: owner.domains } : null);
const ent = (token: string | null) => ({ liveOwner, token: async () => token });
const input = { connectionId: 'conn_od1', provider: 'onedrive' as const, label: 'My OneDrive', owner: owner.id, domain: 'sales', token: REAL_TOKEN };
const NAMES = ['Q3-board-pack.pdf', 'pipeline-notes.md'];
const driveFiles = () => listFiles(owner).mine.filter((f) => NAMES.includes(f.name));
const driveFileNames = () => driveFiles().map((f) => f.name).sort();
const deltaCalls = () => graphCalls.filter((c) => c.url.includes('/delta'));
const contentCalls = () => graphCalls.filter((c) => c.url.endsWith('/content'));

beforeEach(() => { freshNetwork(); __resetConnectors(); __resetStore(); __resetBlobs(); graphCalls = []; graphStatus = 200; contentStatus = {}; });

test('reads Microsoft Graph delta with the token and lands exactly the files Graph returned', async () => {
  const r = await indexDriveSource(input, { liveOwner });
  assert.equal(deltaCalls().length, 1);
  assert.ok(graphCalls.every((c) => c.auth === `Bearer ${REAL_TOKEN}`), 'every Graph call carries the owner token');
  assert.equal(r.mode, 'live');
  assert.equal(r.records, 2, 'two files; the folder item is skipped');
  const sources = listSources(owner.id);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].connectionId, 'conn_od1', 'the source is LINKED to the governed connection');
  assert.equal(sources[0].scope, 'drive');
  assert.deepEqual(driveFileNames(), [...NAMES].sort());
});

test('copy-in reads each file\'s CONTENT through Graph: the bytes are stored and the text is indexed', async () => {
  await indexDriveSource(input, { liveOwner });
  assert.deepEqual(contentCalls().map((c) => c.url.split('/items/')[1]).sort(), ['01ABC/content', '01DEF/content']);
  const notes = driveFiles().find((f) => f.name === 'pipeline-notes.md')!;
  const view = getFile(notes.id, owner);
  assert.match(JSON.stringify(view), /Nordic pipeline closes 4\.2M EUR/, 'the markdown text is the file body that gets embedded');
  assert.equal(view.asset.visibility, 'private', "the owner's drive lands in the owner's scope only");
  assert.throws(() => getFile(notes.id, { id: 'colleague', domains: ['sales'], role: 'creator' }), 'a colleague in the same domain cannot open it');
  const pdf = driveFiles().find((f) => f.name === 'Q3-board-pack.pdf')!;
  const key = objectKeyForAsset(getFile(pdf.id, owner).asset);
  assert.ok(key, 'a copied-in file has an object key');
  const blob = await getBlob(key!);
  assert.ok(blob && blob.body.equals(PDF), 'the PDF bytes from Graph are stored byte-for-byte (Docling reads them)');
});

test('a second Index reuses the linked source (no duplicate source)', async () => {
  const a = await indexDriveSource(input, { liveOwner });
  graphCalls = [];
  const b = await indexDriveSource(input, { liveOwner });
  assert.equal(b.sourceId, a.sourceId);
  assert.equal(graphCalls[0].url, `${GRAPH_DELTA}?token=next`, 'the incremental pass follows the saved deltaLink');
  assert.equal(listSources(owner.id).length, 1);
});

test('twin: index-in-place never downloads content', async () => {
  const { addSource } = await import('./connectors.ts');
  const { runConnectorSync } = await import('./connectors-server.ts');
  const src = addSource({ provider: 'onedrive', label: 'Refs', scope: 'drive', target: 'root', mode: 'reference', owner: owner.id, domain: 'sales', connectionId: 'conn_od1' });
  await runConnectorSync(src.id, owner.id, ent(REAL_TOKEN));
  assert.equal(contentCalls().length, 0);
  assert.deepEqual(driveFileNames(), [...NAMES].sort());
});

test('twin: a file whose content Graph refuses fails the sync loudly, and the next sync imports it once', async () => {
  const { addSource } = await import('./connectors.ts');
  const { runConnectorSync } = await import('./connectors-server.ts');
  const src = addSource({ provider: 'onedrive', label: 'Copy', scope: 'drive', target: 'root', mode: 'copy', owner: owner.id, domain: 'sales', connectionId: 'conn_od1' });
  contentStatus['01DEF'] = 403;
  await assert.rejects(runConnectorSync(src.id, owner.id, ent(REAL_TOKEN)), /Cannot read "pipeline-notes\.md" from OneDrive: Microsoft Graph answered 403/);
  assert.equal(getSource(src.id)!.imported?.['01DEF'], undefined, 'not recorded: nothing half-imported');
  assert.equal(driveFiles().filter((f) => f.name === 'pipeline-notes.md').length, 0, 'no file without its content');
  assert.equal(getSource(src.id)!.initialDone, false, 'the cursor did not advance');
  contentStatus = {};
  await runConnectorSync(src.id, owner.id, ent(REAL_TOKEN));
  assert.equal(driveFiles().filter((f) => f.name === 'pipeline-notes.md').length, 1, 'imported once on the retry');
  assert.equal(getSource(src.id)!.imported?.['01DEF']?.hash, 'qx2');
});

test('twin: Graph refuses the delta (403) — the refusal propagates, no files land, no source is left behind', async () => {
  graphStatus = 403;
  await assert.rejects(indexDriveSource(input, { liveOwner }), /Microsoft Graph answered 403/);
  assert.equal(deltaCalls().length, 1, 'Graph really was called');
  assert.deepEqual(driveFileNames(), []);
  assert.equal(listSources(owner.id).length, 0);
});

test('twin: a wrong token is refused by Graph (401) — nothing lands', async () => {
  await assert.rejects(indexDriveSource({ ...input, token: 'not-the-consented-token' }, { liveOwner }), /Microsoft Graph answered 401/);
  assert.deepEqual(driveFileNames(), []);
});

test('restore real fetch', () => { cluster?.restore(); globalThis.fetch = _realFetch; });
