/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetConnectors,
  addSource,
  listSources,
  removeSource,
  getSource,
  nextCadence,
  runSync,
  mockClient,
  type RemoteFile,
  type ConnectorSource,
  type SyncSink,
  type UpsertOutcome,
} from './connectors.ts';

beforeEach(() => __resetConnectors());

/** A fake store sink: tracks seen files by remoteId→hash, deciding add/update/skip
 *  by content hash, and recording where (re-govern + copy/reference) they landed. */
function fakeSink() {
  const seen = new Map<string, string>(); // remoteId -> hash
  const landed: { name: string; mode: string; sensitivity: string; domain: string; owner: string }[] = [];
  const sink: SyncSink = {
    upsert(file: RemoteFile, source: ConnectorSource): UpsertOutcome {
      const prev = seen.get(file.remoteId);
      seen.set(file.remoteId, file.contentHash);
      landed.push({ name: file.name, mode: source.mode, sensitivity: source.landingSensitivity, domain: source.domain, owner: source.owner });
      if (prev === undefined) return 'added';
      return prev === file.contentHash ? 'unchanged' : 'updated';
    },
  };
  return { sink, landed };
}

test('add / list / remove a connected source (owner-scoped)', () => {
  const s = addSource({ provider: 'google-drive', label: 'Planning', scope: 'folder', target: 'gd-folder', mode: 'copy', owner: 'amir', domain: 'sales' });
  assert.equal(listSources('amir').length, 1);
  assert.equal(listSources('bea').length, 0);
  assert.equal(getSource(s.id)?.provider, 'google-drive');
  assert.equal(removeSource(s.id, 'bea'), false); // not the owner
  assert.equal(removeSource(s.id, 'amir'), true);
  assert.equal(listSources('amir').length, 0);
});

test('cadence: the first pass is overnight, then incremental', () => {
  const s = addSource({ provider: 'google-drive', label: 'P', scope: 'drive', target: 'root', mode: 'copy', owner: 'amir', domain: 'sales' });
  assert.equal(nextCadence(s), 'overnight');
  s.initialDone = true;
  assert.equal(nextCadence(s), 'incremental');
});

test('first sync imports the whole folder (overnight, all added) and re-governs them', async () => {
  const s = addSource({ provider: 'google-drive', label: 'P', scope: 'folder', target: 'gd', mode: 'copy', owner: 'amir', domain: 'sales', landingSensitivity: 'confidential' });
  const { sink, landed } = fakeSink();
  const r = await runSync(s, mockClient('google-drive'), sink);
  assert.equal(r.cadence, 'overnight');
  assert.equal(r.added, 2);
  assert.equal(r.updated, 0);
  assert.ok(r.cursor);
  // re-governed under OUR model: landed at the chosen owner/domain/sensitivity
  assert.ok(landed.every((l) => l.owner === 'amir' && l.domain === 'sales' && l.sensitivity === 'confidential'));
  // cursor + initial flag advanced on the stored source
  assert.equal(getSource(s.id)?.initialDone, true);
});

test('second sync is incremental: only the CHANGED file flows in as an update', async () => {
  const s = addSource({ provider: 'google-drive', label: 'P', scope: 'folder', target: 'gd', mode: 'copy', owner: 'amir', domain: 'sales' });
  const { sink } = fakeSink();
  await runSync(s, mockClient('google-drive'), sink);          // overnight: 2 added
  const r2 = await runSync(s, mockClient('google-drive'), sink); // incremental
  assert.equal(r2.cadence, 'incremental');
  assert.equal(r2.added, 0);
  assert.equal(r2.updated, 1, 'only the changed file (new hash) updates');
});

test('index-in-place keeps the source mode = reference for the sink', async () => {
  const s = addSource({ provider: 'onedrive', label: 'Fin', scope: 'folder', target: 'od', mode: 'reference', owner: 'kenji', domain: 'finance' });
  const { sink, landed } = fakeSink();
  await runSync(s, mockClient('onedrive'), sink);
  assert.ok(landed.every((l) => l.mode === 'reference'));
});
