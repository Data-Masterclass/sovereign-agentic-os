/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        files
 * FEATURE:    File search is really hybrid — lexical (BM25) + k-NN over the stored vectors, fused
 * USER STORY: As someone looking for "how to cancel a contract" I want the termination clause found
 *             even though it never says "cancel" — and never a file I may not read.
 * ARCHITECTURE:
 *   - The embedding client and OpenSearch are injected (controlled vectors, no network).
 *   - The fake OpenSearch IGNORES the DLS filter on purpose — the worst case, a stale or
 *     mis-filtered index — so these tests prove the registry re-check, not the fake.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore, createFile, archiveFile, type Principal } from '@tabs/files/lib/store';
import { searchFilesHybrid, KEYWORD_ONLY_NOTE, type OsSearch, type FileSearchDeps } from '@tabs/files/lib/search';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const kenji: Principal = { id: 'kenji', domains: ['finance'], role: 'builder' };

beforeEach(() => { __resetStore(); });

type Chunk = { fileId: string; text: string; vector: number[] };

function tokens(s: string): string[] { return s.toLowerCase().match(/[a-z0-9]+/g) ?? []; }

/** A fake OpenSearch over `chunks`: knn bodies rank by dot product, multi_match by token overlap.
 *  It records every body so a test can check the DLS filter was sent. */
function fakeIndex(chunks: Chunk[], bodies: Record<string, unknown>[] = []): FileSearchDeps['search'] {
  return async (body) => {
    bodies.push(body);
    const json = JSON.stringify(body);
    const hit = (c: Chunk, i: number, score: number) => ({ _id: `${c.fileId}#${i}`, _score: score, _source: { file_id: c.fileId, text: c.text } });
    if (json.includes('"knn"')) {
      const v = (JSON.parse(json).query.knn?.vector?.vector ?? JSON.parse(json).query.bool.must[0].knn.vector.vector) as number[];
      // OpenSearch's l2 score, 1 / (1 + d²) — every chunk comes back, related or not (as k-NN does).
      const l2 = (c: Chunk) => 1 / (1 + c.vector.reduce((s, x, j) => s + (x - (v[j] ?? 0)) ** 2, 0));
      return { status: 'ok', hits: chunks.map((c, i) => hit(c, i, l2(c))).sort((a, b) => b._score - a._score) } satisfies OsSearch;
    }
    const q = new Set(tokens(JSON.parse(json).query.bool.must[0].multi_match.query));
    return { status: 'ok', hits: chunks.map((c, i) => hit(c, i, tokens(c.text).filter((t) => q.has(t)).length)).filter((h) => h._score > 0).sort((a, b) => b._score - a._score) } satisfies OsSearch;
  };
}

/** Controlled vectors: the query about cancelling sits next to the termination clause. */
const VEC: Record<string, number[]> = {
  'how to cancel a contract': [0.95, 0.05, 0],
  'holiday menu': [0, 1, 0],
};
const embed: FileSearchDeps['embed'] = async (text) => ({ vector: VEC[text] ?? [0, 0, 1], mode: 'live' });

function corpus() {
  const msa = createFile(amir, { name: 'msa-v3.pdf', text: 'Termination: either party may end this agreement with thirty days notice.' });
  const party = createFile(amir, { name: 'holiday-party.docx', text: 'Holiday menu: soup, roast, dessert.' });
  return { msa, party, chunks: [
    { fileId: msa.id, text: 'Termination: either party may end this agreement with thirty days notice.', vector: [1, 0, 0] },
    { fileId: party.id, text: 'Holiday menu: soup, roast, dessert.', vector: [0, 1, 0] },
  ] };
}

test('SEMANTIC: a file that shares no keyword with the query is found through its vector', async () => {
  const { msa, chunks } = corpus();
  const res = await searchFilesHybrid(amir, 'how to cancel a contract', { embed, search: fakeIndex(chunks) });
  assert.equal(res.mode, 'hybrid');
  assert.equal(res.note, undefined);
  assert.equal(res.hits[0]?.id, msa.id, 'the termination clause is the top hit');
  assert.deepEqual(res.hits[0].matchedBy, ['semantic']);
  assert.match(res.hits[0].snippet, /Termination/);
});

test('LEXICAL: a keyword match is still found (and found by both halves when it also means it)', async () => {
  const { party, chunks } = corpus();
  const res = await searchFilesHybrid(amir, 'holiday menu', { embed, search: fakeIndex(chunks) });
  assert.equal(res.hits[0]?.id, party.id);
  assert.ok(res.hits[0].matchedBy.includes('lexical') && res.hits[0].matchedBy.includes('semantic'), res.hits[0].matchedBy.join(','));
});

test('FLOOR: an unrelated query returns nothing — the k nearest are not matches', async () => {
  const { chunks } = corpus();
  const res = await searchFilesHybrid(amir, 'quantum chromodynamics', { embed, search: fakeIndex(chunks) });
  assert.equal(res.mode, 'hybrid');
  assert.deepEqual(res.hits, [], 'no file is related, so none is shown');
});

test('DLS: another user’s private file is never returned, even when the index hands it back', async () => {
  const { chunks } = corpus(); // amir's PRIVATE files
  const bodies: Record<string, unknown>[] = [];
  const res = await searchFilesHybrid(kenji, 'how to cancel a contract', { embed, search: fakeIndex(chunks, bodies) });
  assert.equal(res.hits.length, 0, 'kenji sees none of amir’s private files');
  // And the compiled DLS went to OpenSearch on BOTH halves, with the indexed field names.
  assert.equal(bodies.length, 2);
  for (const b of bodies) {
    const s = JSON.stringify(b);
    assert.match(s, /"owner":"kenji"/);
    assert.match(s, /"granted_users":"kenji"/, 'the named-grant clause uses the field the index holds');
    assert.doesNotMatch(s, /grantedUsers/);
  }
});

test('RESTRICTED and ARCHIVED: never returned, even to the owner, even from a stale index row', async () => {
  const secret = createFile(amir, { name: 'board-minutes.pdf', sensitivity: 'restricted', text: 'Termination of the chief executive.' });
  const old = createFile(amir, { name: 'old-msa.pdf', text: 'Termination: either party may end this agreement.' });
  archiveFile(old.id, amir);
  const chunks: Chunk[] = [
    { fileId: secret.id, text: 'Termination of the chief executive.', vector: [1, 0, 0] },
    { fileId: old.id, text: 'Termination: either party may end this agreement.', vector: [1, 0, 0] },
  ];
  const res = await searchFilesHybrid(amir, 'how to cancel a contract', { embed, search: fakeIndex(chunks) });
  assert.ok(!res.hits.some((h) => h.id === secret.id), 'restricted never surfaces');
  assert.ok(!res.hits.some((h) => h.id === old.id), 'archived never surfaces');
});

test('FALLBACK: OpenSearch unreachable → the keyword scan, labelled, and no invented semantic hit', async () => {
  const { msa, party } = corpus();
  const down: FileSearchDeps['search'] = async () => ({ status: 'unreachable' });
  const sem = await searchFilesHybrid(amir, 'how to cancel a contract', { embed, search: down });
  assert.equal(sem.mode, 'keyword-only');
  assert.equal(sem.note, KEYWORD_ONLY_NOTE);
  assert.match(KEYWORD_ONLY_NOTE, /keyword only \(search index unavailable\)/);
  assert.ok(!sem.hits.some((h) => h.id === msa.id), 'without the index there is no semantic match — none is made up');
  const kw = await searchFilesHybrid(amir, 'holiday', { embed, search: down });
  assert.equal(kw.mode, 'keyword-only');
  assert.equal(kw.hits[0]?.id, party.id);
  assert.deepEqual(kw.hits[0].matchedBy, ['keyword']);
});

test('FALLBACK: embedding gateway down → lexical half only, said so', async () => {
  const { party, chunks } = corpus();
  const broken: FileSearchDeps['embed'] = async () => { throw new Error('gateway 503'); };
  const res = await searchFilesHybrid(amir, 'holiday menu', { embed: broken, search: fakeIndex(chunks) });
  assert.equal(res.mode, 'lexical');
  assert.match(res.note ?? '', /semantic half was skipped/);
  assert.equal(res.hits[0]?.id, party.id);
});

test('FALLBACK: a gateway slower than the wait → lexical half only, said so (no stall)', async () => {
  const { party, chunks } = corpus();
  const slow: FileSearchDeps['embed'] = () => new Promise((r) => setTimeout(() => r({ vector: [0, 1, 0], mode: 'live' }), 200));
  const res = await searchFilesHybrid(amir, 'holiday menu', { embed: slow, search: fakeIndex(chunks), embedWaitMs: 20 });
  assert.equal(res.mode, 'lexical');
  assert.equal(res.hits[0]?.id, party.id);
});

test('FALLBACK: a stand-in (hash) query vector is never compared with real stored vectors', async () => {
  const { chunks } = corpus();
  const bodies: Record<string, unknown>[] = [];
  const mock: FileSearchDeps['embed'] = async () => ({ vector: [1, 0, 0], mode: 'mock' });
  const res = await searchFilesHybrid(amir, 'how to cancel a contract', { embed: mock, search: fakeIndex(chunks, bodies) });
  assert.equal(res.mode, 'lexical');
  assert.ok(!bodies.some((b) => JSON.stringify(b).includes('"knn"')), 'no k-NN query was sent');
});

test('KNN FILTER REJECTED: falls back to a post-filtered k-NN, DLS still in the query', async () => {
  const { msa, chunks } = corpus();
  const inner = fakeIndex(chunks);
  const bodies: Record<string, unknown>[] = [];
  const search: FileSearchDeps['search'] = async (body) => {
    bodies.push(body);
    const s = JSON.stringify(body);
    if (s.includes('"knn"') && JSON.parse(s).query.knn) return { status: 'rejected' }; // engine without efficient filtering
    return inner(body);
  };
  const res = await searchFilesHybrid(amir, 'how to cancel a contract', { embed, search });
  assert.equal(res.mode, 'hybrid');
  assert.equal(res.hits[0]?.id, msa.id);
  const post = bodies.find((b) => JSON.stringify(b).includes('"knn"') && !(b as { query: { knn?: unknown } }).query.knn);
  assert.ok(post && JSON.stringify(post).includes('"owner":"amir"'), 'the post-filter carries the DLS');
});

test('the result is an object an agent grant filter can narrow: every hit carries its file id', async () => {
  const { chunks } = corpus();
  const res = await searchFilesHybrid(amir, 'holiday menu', { embed, search: fakeIndex(chunks) });
  assert.ok(res.hits.every((h) => typeof h.id === 'string' && h.id.length > 0));
  assert.equal(typeof res.total, 'number');
});
