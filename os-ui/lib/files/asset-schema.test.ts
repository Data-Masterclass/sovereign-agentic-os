/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAsset,
  serializeAsset,
  fileKindFromName,
  assetTypeFor,
  objectPrefixFor,
  deepLinkFor,
  indexingModeFor,
  emptyAsset,
  AssetError,
  type FileAsset,
} from './asset-schema.ts';
// The governance lifecycle is RE-USED from the Data tab (locked decision #note):
// Files are governed exactly like Data — same tiers, roles, visibility.
import { canTransition, tierAfter, visibilityFor } from '../data/dataset-schema.ts';

function sample(over: Partial<FileAsset> = {}): FileAsset {
  return { ...emptyAsset({ id: 'as_x', name: 'acme.pdf', owner: 'amir', domain: 'sales' }), ...over };
}

test('file kind is inferred from the name extension', () => {
  assert.equal(fileKindFromName('acme-contract.pdf'), 'doc');
  assert.equal(fileKindFromName('logo.PNG'), 'image');
  assert.equal(fileKindFromName('standup.m4a'), 'audio');
  assert.equal(fileKindFromName('demo.mp4'), 'video');
  assert.equal(fileKindFromName('orders.csv'), 'table');
  assert.equal(fileKindFromName('bundle.zip'), 'archive');
  assert.equal(fileKindFromName('mystery'), 'other');
});

test('assetType is the context-layer file.<kind> envelope tag', () => {
  assert.equal(assetTypeFor('doc'), 'file.doc');
  assert.equal(assetTypeFor('audio'), 'file.audio');
});

test('object-store prefix: private files under the owner; shared/certified under the domain', () => {
  // The storageFor analog (handover): dataset(private) -> owner; asset/product -> domain.
  assert.equal(objectPrefixFor('dataset', 'amir', 'sales'), 's3://files/amir/');
  assert.equal(objectPrefixFor('asset', 'amir', 'sales'), 's3://files/sales/');
  assert.equal(objectPrefixFor('product', 'amir', 'sales'), 's3://files/sales/');
});

test('deep-link is the object-store prefix + folder + name for stored files', () => {
  const a = sample({ folder: '/contracts', name: 'acme.pdf', storage: 'object-store' });
  assert.equal(deepLinkFor(a), 's3://files/amir/contracts/acme.pdf');
});

test('in-place files keep their source deep-link untouched', () => {
  const a = sample({ storage: 'in-place', deepLink: 'gdrive://folder/acme.pdf' });
  assert.equal(deepLinkFor(a), 'gdrive://folder/acme.pdf');
});

test('restricted sensitivity forces stored-only indexing (decision #7)', () => {
  assert.equal(indexingModeFor('restricted', 'indexed'), 'stored-only');
  assert.equal(indexingModeFor('confidential', 'indexed'), 'indexed');
  assert.equal(indexingModeFor('internal'), 'indexed'); // default indexed
});

test('parse clamps a restricted file to stored-only even if asked to index', () => {
  const a = parseAsset({
    id: 'as_secret', name: 'salaries.xlsx', owner: 'amir', domain: 'sales',
    sensitivity: 'restricted', indexing: { mode: 'indexed', representations: ['table'], chunkHashes: ['abc'] },
  });
  assert.equal(a.sensitivity, 'restricted');
  assert.equal(a.indexing.mode, 'stored-only');
});

test('parse clamps visibility to the tier (reused Data lifecycle)', () => {
  const a = parseAsset({ id: 'as_x', name: 'x.pdf', owner: 'amir', domain: 'sales', tier: 'dataset', visibility: 'public' });
  assert.equal(a.visibility, 'private'); // a private file is owner-only
});

test('parse/serialize round-trips the file envelope', () => {
  const a = sample({
    folder: '/contracts', tags: ['acme', 'renewal'], sensitivity: 'confidential',
    version: 'v2', relationships: [{ kind: 'derived-from', targetId: 'as_src' }],
  });
  const round = parseAsset(serializeAsset(a));
  assert.equal(round.name, 'acme.pdf');
  assert.equal(round.folder, '/contracts');
  assert.deepEqual(round.tags, ['acme', 'renewal']);
  assert.equal(round.sensitivity, 'confidential');
  assert.equal(round.version, 'v2');
  assert.equal(round.relationships[0].targetId, 'as_src');
  assert.equal(round.assetType, 'file.doc');
});

test('bad shape throws an AssetError (the store never holds garbage)', () => {
  assert.throws(() => parseAsset({ name: 'x.pdf', sensitivity: 'nonsense' }), AssetError);
  assert.throws(() => parseAsset({ name: 'x.pdf', tier: 'bogus' }), AssetError);
});

test('the reused lifecycle still gates files: Creator cannot promote, Builder can', () => {
  // sanity that the imported governance is wired (no separate Files lifecycle).
  assert.equal(canTransition('creator', 'dataset', 'promote').ok, false);
  assert.equal(canTransition('builder', 'dataset', 'promote').ok, true);
  assert.equal(tierAfter('dataset', 'promote'), 'asset');
  assert.equal(visibilityFor('asset', 'public'), 'shared');
});
