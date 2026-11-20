/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The legacy (pre-WP-37) dataset version view is read-only and keeps every record
 * USER STORY: As a data owner I want the old definition history readable, and never changed.
 * ARCHITECTURE: a fake OpenSearch over global.fetch records every request the reader sends.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore, createDataset, type Principal } from '@tabs/data/lib/store';
import { listLegacyDatasetVersions } from '@tabs/data/lib/legacy-versions';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const kenji: Principal = { id: 'kenji', domains: ['finance'], role: 'creator' };
beforeEach(() => __resetStore());

function fakeOpenSearch(docs: Record<string, unknown>[], status = 200) {
  const sent: { method: string; url: string }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ method: init?.method ?? 'GET', url });
    if (!url.includes('os-versions-dataset')) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ hits: { hits: docs.map((_source) => ({ _source })) } }), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = orig; } };
}

test('the old dataset.yaml snapshots are listed newest first, with their bytes', async () => {
  const d = createDataset(amir, { name: 'Orders' });
  const os = fakeOpenSearch([
    { kind: 'dataset', artifactId: d.id, version: 1, at: '2026-11-01T10:00:00Z', author: 'amir', summary: 'edit docs', state: { yaml: 'v1' } },
    { kind: 'dataset', artifactId: d.id, version: 2, at: '2026-11-02T10:00:00Z', author: 'amir', summary: 'rename', state: { yaml: 'v2' } },
    { kind: 'dataset', artifactId: 'ds_other', version: 9, at: '2026-11-02T10:00:00Z', author: 'x', summary: 'x', state: { yaml: 'no' } },
  ]);
  try {
    const r = await listLegacyDatasetVersions(d.id, amir);
    assert.equal(r.available, true);
    assert.deepEqual(r.versions.map((v) => [v.version, v.yaml]), [[2, 'v2'], [1, 'v1']]);
    // Read-only: only searches on the legacy index; never PUT/DELETE/_update/_doc, never index creation.
    const legacy = os.sent.filter((s) => s.url.includes('os-versions-dataset'));
    assert.ok(legacy.length >= 1);
    assert.ok(legacy.every((s) => s.method === 'POST' && s.url.endsWith('/os-versions-dataset/_search')), JSON.stringify(legacy));
  } finally {
    os.restore();
  }
});

test('an unreachable OpenSearch is said, not shown as "no history"; an unseen dataset is refused first', async () => {
  const d = createDataset(amir, { name: 'Orders' });
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('down'); }) as typeof fetch;
  try {
    const r = await listLegacyDatasetVersions(d.id, amir);
    assert.equal(r.available, false);
  } finally {
    globalThis.fetch = orig;
  }
  const os = fakeOpenSearch([]);
  try {
    await assert.rejects(listLegacyDatasetVersions(d.id, kenji), (e: { status?: number }) => e.status === 403);
    assert.equal(os.sent.filter((s) => s.url.includes('os-versions-dataset')).length, 0, 'refused before any read');
  } finally {
    os.restore();
  }
});
