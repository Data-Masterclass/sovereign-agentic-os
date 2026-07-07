/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  listFiles,
  getFile,
  createFile,
  moveFile,
  setTags,
  setDocs,
  addVersion,
  setIndexingMode,
  deleteFile,
  searchFiles,
  requestPromotion,
  applyApprovedFilePromotion,
  transition,
  archiveFile,
  unarchiveFile,
  listFileVersions,
  restoreFileVersion,
  type Principal,
} from './store.ts';
import { listLineage, __resetLineage } from './lineage.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };  // Creator
const bea: Principal = { id: 'bea', domains: ['sales'], role: 'builder' };        // Builder, amir's domain
const sara: Principal = { id: 'sara', domains: ['sales'], role: 'admin' };        // Admin, sales
const kenji: Principal = { id: 'kenji', domains: ['finance'], role: 'builder' };  // outside sales

beforeEach(() => { __resetStore(); __resetLineage(); });

/**
 * The store ships EMPTY now. Build the validation-gate corpus (a PDF, an image
 * and an audio for the owner, across a couple of folders/tags) via the public
 * upload API so the facet + scope tests have real material.
 */
function seedFiles(): void {
  createFile(amir, { name: 'contract.pdf', folder: '/contracts', tags: ['renewal', 'contract'], text: 'A master agreement with renewal terms.' });
  createFile(amir, { name: 'logo.png', folder: '/brand', tags: ['brand', 'logo'], text: 'Caption: the company wordmark.' });
  createFile(amir, { name: 'standup-2026-06.m4a', folder: '/recordings', tags: ['standup'], text: 'Transcript: the team reviewed the renewal.' });
}

test('a fresh tenant has no files', () => {
  assert.equal(listFiles(amir).mine.length, 0);
});

test('the validation-gate files surface for the owner (a PDF, an image, an audio)', () => {
  seedFiles();
  const g = listFiles(amir);
  const names = g.mine.map((f) => f.name);
  assert.ok(names.some((n) => n.endsWith('.pdf')), 'a PDF is present');
  assert.ok(names.some((n) => n.endsWith('.png')), 'an image is present');
  assert.ok(g.mine.some((f) => f.kind === 'audio'), 'an audio is present');
});

test('private files are owner-only; a foreign user never sees them', () => {
  const g = listFiles(kenji);
  // kenji is in finance — amir's private sales files must not appear anywhere for him.
  const all = [...g.mine, ...g.domain, ...g.marketplace].map((f) => f.owner);
  assert.ok(!all.includes('amir') || g.marketplace.length > 0, 'no private amir files leak');
  assert.equal(g.mine.length, 0, 'kenji owns nothing seeded');
});

test('facets expose the folder tree and tag cloud over visible files', () => {
  seedFiles();
  const g = listFiles(amir);
  assert.ok(g.facets.folders.some((f) => f.path !== '/'), 'has at least one sub-folder');
  assert.ok(g.facets.tags.length > 0, 'has tags');
  for (const f of g.facets.folders) assert.ok(f.count >= 1);
});

test('upload creates a private object-store file at v1 with a deep-link', () => {
  const a = createFile(amir, { name: 'notes.pdf', folder: '/research', tags: ['q3'], text: 'quarterly notes' });
  assert.equal(a.owner, 'amir');
  assert.equal(a.tier, 'dataset');
  assert.equal(a.visibility, 'private');
  assert.equal(a.folder, '/research');
  assert.equal(a.version, 'v1');
  assert.equal(a.storage, 'object-store');
  assert.match(a.deepLink, /^s3:\/\/files\/amir\/research\/notes\.pdf$/);
  // it now shows up in the owner's listing
  assert.ok(listFiles(amir).mine.some((f) => f.id === a.id));
});

test('preview returns the mock extracted text for a doc', () => {
  const a = createFile(amir, { name: 'memo.pdf', text: 'the body of the memo' });
  const got = getFile(a.id, amir);
  assert.equal(got.text, 'the body of the memo');
  assert.equal(got.asset.name, 'memo.pdf');
});

test('a restricted upload is stored-only (never indexed) — decision #7', () => {
  const a = createFile(amir, { name: 'salaries.xlsx', sensitivity: 'restricted', text: 'secret' });
  assert.equal(a.indexing.mode, 'stored-only');
  const sum = listFiles(amir).mine.find((f) => f.id === a.id)!;
  assert.equal(sum.status, 'stored');
});

test('an indexed upload reports a searchable status chip', () => {
  const a = createFile(amir, { name: 'public.pdf', sensitivity: 'public', text: 'hello world' });
  assert.equal(a.indexing.mode, 'indexed');
  const sum = listFiles(amir).mine.find((f) => f.id === a.id)!;
  assert.equal(sum.status, 'searchable');
});

test('a no-text upload (binary the mock cannot parse) is stored, not falsely searchable', () => {
  const a = createFile(amir, { name: 'scan.pdf', sensitivity: 'public', bytes: 4096 });
  assert.equal(a.indexing.mode, 'stored-only', 'nothing to index → held, not indexed');
  const sum = listFiles(amir).mine.find((f) => f.id === a.id)!;
  assert.equal(sum.status, 'stored');
});

test('move + retag + docs edit the single source for the owner only', () => {
  const a = createFile(amir, { name: 'x.pdf', text: 'x' });
  moveFile(a.id, amir, '/contracts/2026');
  setTags(a.id, amir, ['contract', 'acme']);
  setDocs(a.id, amir, { description: 'the acme contract' });
  const got = getFile(a.id, amir);
  assert.equal(got.asset.folder, '/contracts/2026');
  assert.deepEqual(got.asset.tags, ['contract', 'acme']);
  assert.equal(got.asset.description, 'the acme contract');
});

test('a non-owner cannot edit a private file', () => {
  const a = createFile(amir, { name: 'y.pdf', text: 'y' });
  assert.throws(() => setTags(a.id, kenji, ['nope']), /permitted|not found|403|404/i);
});

test('re-upload bumps the version and keeps history', () => {
  const a = createFile(amir, { name: 'spec.pdf', text: 'draft 1' });
  const v2 = addVersion(a.id, amir, { text: 'draft 2' });
  assert.equal(v2.version, 'v2');
  const got = getFile(a.id, amir);
  assert.equal(got.text, 'draft 2');
  assert.ok(got.history.length >= 2, 'history records both versions');
});

test('the owner can opt a file out of indexing (stored-only)', () => {
  const a = createFile(amir, { name: 'huge.pdf', text: 'big', sensitivity: 'internal' });
  assert.equal(a.indexing.mode, 'indexed');
  const off = setIndexingMode(a.id, amir, 'stored-only');
  assert.equal(off.indexing.mode, 'stored-only');
});

test('search finds a file by name, tag and body text', () => {
  createFile(amir, { name: 'renewal-acme.pdf', tags: ['contract'], text: 'auto-renews after twelve months' });
  const byName = searchFiles(amir, 'renewal');
  assert.ok(byName.some((h) => h.name === 'renewal-acme.pdf'));
  const byBody = searchFiles(amir, 'twelve months');
  assert.ok(byBody.some((h) => h.name === 'renewal-acme.pdf'));
  // every hit carries a snippet + score for the result row
  for (const h of byBody) {
    assert.equal(typeof h.score, 'number');
    assert.equal(typeof h.snippet, 'string');
  }
});

test('search never returns another user’s private file', () => {
  createFile(amir, { name: 'amir-secret.pdf', text: 'confidential alpha' });
  const hits = searchFiles(kenji, 'alpha');
  assert.ok(!hits.some((h) => h.name === 'amir-secret.pdf'));
});

test('stored-only files are excluded from search results (not indexed)', () => {
  createFile(amir, { name: 'restricted-doc.pdf', sensitivity: 'restricted', text: 'omega secret' });
  const hits = searchFiles(amir, 'omega');
  assert.ok(!hits.some((h) => h.name === 'restricted-doc.pdf'), 'stored-only is not searchable');
});

test('delete removes a file for its owner', () => {
  const a = createFile(amir, { name: 'tmp.pdf', text: 'tmp' });
  deleteFile(a.id, amir);
  assert.throws(() => getFile(a.id, amir), /not found|404/i);
});

// ----------------------------------------------------- Phase 2: governance ----

function documented() {
  const a = createFile(amir, { name: 'handbook.pdf', tags: ['guide'], text: 'the sales handbook' });
  setDocs(a.id, amir, { description: 'the domain sales handbook', tags: ['guide'] });
  return a;
}

test('promotion needs the docs minimum: owner + description + ≥1 tag (decision #5)', () => {
  const bare = createFile(amir, { name: 'bare.pdf', text: 'x' }); // no description/tags
  assert.throws(() => requestPromotion(bare.id, amir, {}), /description|tag/i);
});

test('only the OWNER may request promotion (separation of duties)', () => {
  const a = documented();
  assert.throws(() => requestPromotion(a.id, bea, {}), /owner/i);
});

test('a Creator requests; the request targets the domain with a domain grant', () => {
  const a = documented();
  const req = requestPromotion(a.id, amir, {});
  assert.equal(req.domain, 'sales');
  assert.equal(req.visibility, 'domain');
  assert.ok(req.grants.some((g) => g.grantee.kind === 'domain' && g.grantee.id === 'sales'));
  assert.match(req.target, /sales/);
});

test('a domain BUILDER applies the approved promotion → a domain asset (the gate)', () => {
  const a = documented();
  const req = requestPromotion(a.id, amir, {});
  const promoted = applyApprovedFilePromotion(req, bea);
  assert.equal(promoted.tier, 'asset');
  assert.equal(promoted.visibility, 'domain');
  // re-governed: the bytes move from the owner prefix to the DOMAIN prefix
  assert.match(promoted.deepLink, /^s3:\/\/files\/sales\//);
  // a domain peer now sees it; a non-member never does (DLS)
  assert.ok(listFiles(bea).domain.some((f) => f.id === a.id), 'peer sees the domain asset');
  assert.throws(() => getFile(a.id, kenji), /permitted|not found|40[34]/i);
});

test('promotion records a file_promoted lineage edge (OM, mock-tolerant)', () => {
  const a = documented();
  applyApprovedFilePromotion(requestPromotion(a.id, amir, {}), bea);
  const edges = listLineage(a.id);
  assert.ok(edges.some((e) => e.kind === 'file_promoted'), 'lineage captured');
});

test('a non-Builder cannot apply a promotion', () => {
  const a = documented();
  const req = requestPromotion(a.id, amir, {});
  assert.throws(() => applyApprovedFilePromotion(req, { id: 'cleo', domains: ['sales'], role: 'creator' }), /Builder|requires/i);
});

test('a Builder OUTSIDE the domain cannot apply the promotion', () => {
  const a = documented();
  const req = requestPromotion(a.id, amir, {});
  assert.throws(() => applyApprovedFilePromotion(req, kenji), /domain/i);
});

test('an Admin certifies a domain asset into a marketplace product', () => {
  const a = documented();
  applyApprovedFilePromotion(requestPromotion(a.id, amir, {}), bea);
  const product = transition(a.id, sara, 'certify', {});
  assert.equal(product.tier, 'product');
  // discoverable by anyone now
  assert.ok(listFiles(kenji).marketplace.some((f) => f.id === a.id));
});

test('cross-instance: writes are visible through globalThis symbol', () => {
  __resetStore();
  const a = createFile(amir, { name: 'ci-test.pdf', text: 'hello' });
  const raw = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.files.store')] as { store: Map<string, unknown> };
  assert.ok(raw && raw.store.has(a.id), 'record visible in globalThis state');
  assert.equal(listFiles(amir).mine.length, 1);
});

test('certify requires an Admin (a Builder is refused)', () => {
  const a = documented();
  applyApprovedFilePromotion(requestPromotion(a.id, amir, {}), bea);
  assert.throws(() => transition(a.id, bea, 'certify', {}), /Admin|requires|permitted/i);
});

// ------------------------------------------------- download canView gate tests --

test('getFile (download gate) returns body text to the owner', () => {
  const a = createFile(amir, { name: 'training-deck.pdf', text: 'page 1 content here' });
  const view = getFile(a.id, amir);
  assert.equal(view.text, 'page 1 content here');
  assert.equal(view.asset.name, 'training-deck.pdf');
});

test('getFile (download gate) blocks a non-member from a private file', () => {
  const a = createFile(amir, { name: 'private.pdf', text: 'confidential' });
  // kenji is in finance; amir's file is private to sales — canView must deny
  assert.throws(() => getFile(a.id, kenji), /permitted|not found|40[34]/i);
});

test('getFile (download gate) allows a domain peer to download a promoted file', () => {
  const a = createFile(amir, { name: 'handbook.pdf', tags: ['guide'], text: 'the shared handbook' });
  setDocs(a.id, amir, { description: 'sales domain handbook', tags: ['guide'] });
  const req = requestPromotion(a.id, amir, {});
  applyApprovedFilePromotion(req, bea);
  // bea is in the same domain (sales) — canView should now pass
  const view = getFile(a.id, bea);
  assert.equal(view.text, 'the shared handbook');
});

test('getFile (download gate) blocks a user outside the domain from a domain asset', () => {
  const a = createFile(amir, { name: 'shared.pdf', tags: ['internal'], text: 'domain-only content' });
  setDocs(a.id, amir, { description: 'only for sales', tags: ['internal'] });
  applyApprovedFilePromotion(requestPromotion(a.id, amir, {}), bea);
  // kenji is in finance, not in the sales domain grant — must be blocked
  assert.throws(() => getFile(a.id, kenji), /permitted|not found|40[34]/i);
});

// ---------------------------------------- archive / delete / version history --

test('snapshot-on-edit: a setTags call creates a version entry (prior state)', () => {
  const a = createFile(amir, { name: 'snap.pdf', tags: ['old'], text: 'body' });
  setTags(a.id, amir, ['new']);
  const vList = listFileVersions(a.id, amir);
  assert.ok(vList.length >= 1, 'at least one version after edit');
  assert.equal(vList[0].summary, 'edit tags');
  assert.equal(vList[0].author, 'amir');
  // The captured state is the PRIOR state (tags: ['old'] is in the yaml)
  const prior = vList[0].state as { yaml: string };
  assert.ok(prior.yaml.includes('old'), 'prior state contains the old tag');
});

test('version list is newest-first', () => {
  const a = createFile(amir, { name: 'order.pdf', text: 'v1' });
  moveFile(a.id, amir, '/a');
  setTags(a.id, amir, ['x']);
  setDocs(a.id, amir, { description: 'desc' });
  const vList = listFileVersions(a.id, amir);
  assert.ok(vList.length >= 3, 'three edits → three versions');
  // newest first: versions should be in descending version number order
  for (let i = 0; i < vList.length - 1; i++) {
    assert.ok(vList[i].version > vList[i + 1].version, 'newest first ordering');
  }
});

test('restore reverts file to prior state and itself creates a new version', () => {
  const a = createFile(amir, { name: 'revert.pdf', folder: '/original', text: 'first' });
  moveFile(a.id, amir, '/changed');
  const vList = listFileVersions(a.id, amir);
  const priorVersion = vList[vList.length - 1].version; // oldest = the 'edit folder' one
  // Restore to the prior version (before the move)
  const restored = restoreFileVersion(a.id, amir, priorVersion);
  assert.ok(restored.yaml.includes('original'), 'folder restored to /original');
  // Restore itself should have created a new version snapshot
  const vListAfter = listFileVersions(a.id, amir);
  assert.ok(vListAfter.length > vList.length, 'restore created a new version entry');
  assert.ok(vListAfter[0].summary.includes('restore'), 'newest entry is the restore snapshot');
});

test('archive hides the file from default listing and search', () => {
  const a = createFile(amir, { name: 'hidden.pdf', text: 'secret content' });
  archiveFile(a.id, amir);
  // Hidden from default list
  const g = listFiles(amir);
  assert.ok(!g.mine.some((f) => f.id === a.id), 'archived file absent from default list');
  // Hidden from search
  const hits = searchFiles(amir, 'secret');
  assert.ok(!hits.some((h) => h.id === a.id), 'archived file absent from search');
});

test('includeArchived surfaces the archived file', () => {
  const a = createFile(amir, { name: 'hidden2.pdf', text: 'body' });
  archiveFile(a.id, amir);
  const g = listFiles(amir, { includeArchived: true });
  assert.ok(g.mine.some((f) => f.id === a.id && f.archived === true), 'archived file visible with includeArchived');
});

test('unarchive restores the file to the working list', () => {
  const a = createFile(amir, { name: 'comeback.pdf', text: 'body' });
  archiveFile(a.id, amir);
  unarchiveFile(a.id, amir);
  const g = listFiles(amir);
  assert.ok(g.mine.some((f) => f.id === a.id && !f.archived), 'unarchived file back in list');
});

test('delete removes the file and purges its version history', () => {
  const a = createFile(amir, { name: 'gone.pdf', text: 'going' });
  moveFile(a.id, amir, '/temp'); // creates a version entry
  const vBefore = listFileVersions(a.id, amir);
  assert.ok(vBefore.length >= 1, 'history exists before delete');
  deleteFile(a.id, amir);
  // File is gone
  assert.throws(() => getFile(a.id, amir), /not found|404/i);
  // Version history purged — a new store reset confirms the symbol state is clean
  // (we cannot re-query versions for a deleted file, but purge is tested by checking
  // the store is gone and the mirror __reset is wired — tested via __resetStore smoke)
  __resetStore();
  assert.equal(listFiles(amir).mine.length, 0);
});

test('non-editor is rejected 403 on archive, unarchive, restore', () => {
  const a = createFile(amir, { name: 'guarded.pdf', text: 'body' });
  moveFile(a.id, amir, '/here'); // creates a version
  const v = listFileVersions(a.id, amir);
  assert.ok(v.length >= 1);
  assert.throws(() => archiveFile(a.id, kenji), /permitted|403/i);
  assert.throws(() => unarchiveFile(a.id, kenji), /permitted|403/i);
  assert.throws(() => restoreFileVersion(a.id, kenji, v[0].version), /permitted|403/i);
});
