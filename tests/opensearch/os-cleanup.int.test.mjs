/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * os-cleanup.int.test (WP-21, design 02 step 1) — the chart's `opensearch-orphan-cleanup` Job
 * script against the REAL image, with the live orphan shapes AND look-alike decoys:
 *   - only `<x>_search_index_rebuild_<13 digits>`, `<x>_report_data_index_rebuild_<13 digits>`, the `di-data-assets-<type>` data streams
 *     (with their `.ds-*` backing indices) and `haystack_knowledge` are deleted;
 *   - every decoy and every OS index survives;
 *   - a snapshot is taken first (SUCCESS, in the S3 repository) and the orphans are in it;
 *   - more matches than `maxDelete` -> refuses and deletes nothing; dry run deletes nothing;
 *   - a second run is a no-op (idempotent).
 *
 * Run: bash tests/opensearch/up.sh && node --test tests/opensearch/os-cleanup.int.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { os, runJob, setProxy } from './harness.mjs';

const ORPHAN_INDICES = ['table_search_index_rebuild_1792888201314', 'ai_agent_search_index_rebuild_1792888201315', 'entity_report_data_index_rebuild_1792888206368', 'haystack_knowledge'];
const ORPHAN_STREAMS = ['di-data-assets-table', 'di-data-assets-glossaryterm'];
const DECOY_INDICES = ['os-users', 'files', 'knowledge', 'haystack_knowledge_v2', 'table_search_index_rebuild', 'x_search_index_rebuild_123', 'my-table_search_index_rebuild_1792888201314', 'entity_report_data_index_rebuild', 'entity_report_data_rebuild_1792888206368', 'os-report_data_index_rebuild_1792888206368'];
const DECOY_STREAMS = ['logs-di-data-assets-table', 'di-data-assets-a-b'];
const ENV = 'opensearch-orphan-cleanup.env';

const names = () => {
  const r = os('GET', '/_cat/indices?h=index&expand_wildcards=all&format=json');
  return new Set((r.body ?? []).map((x) => x.index));
};
const streams = () => new Set((os('GET', '/_data_stream').body.data_streams ?? []).map((s) => s.name));

function seed() {
  for (const i of [...ORPHAN_INDICES, ...DECOY_INDICES]) {
    os('DELETE', `/${i}`);
    assert.equal(os('PUT', `/${i}/_doc/1?refresh=true`, { seeded: true }).status, 201, i);
  }
  os('PUT', '/_index_template/wp21-it-streams', {
    index_patterns: ['di-data-assets-*', 'logs-di-data-assets-*'], data_stream: {}, priority: 500,
  });
  for (const s of [...ORPHAN_STREAMS, ...DECOY_STREAMS]) {
    os('DELETE', `/_data_stream/${s}`);
    assert.equal(os('POST', `/${s}/_doc?refresh=true`, { '@timestamp': '2026-11-20T00:00:00Z', seeded: true }).status, 201, s);
  }
}

test('cleanup: guarded, snapshot first, deletes exactly the documented patterns, idempotent', { timeout: 10 * 60 * 1000 }, () => {
  setProxy('proxy');
  const reg = runJob('register-s3.sh', 'register-opensearch-s3-repo.env');
  assert.equal(reg.code, 0, reg.log);
  seed();
  const orphanCount = ORPHAN_INDICES.length + ORPHAN_STREAMS.length; // one backing index per stream

  // Guard: more matches than maxDelete -> refuse, nothing deleted.
  const guard = runJob('delete-orphans.sh', ENV, { OS_CLEANUP_MAX_DELETE: String(orphanCount - 1) });
  assert.notEqual(guard.code, 0, guard.log);
  assert.match(guard.log, /Refusing/);
  for (const i of ORPHAN_INDICES) assert.ok(names().has(i), `guard deleted ${i}`);

  // Dry run: lists, deletes nothing.
  const dry = runJob('delete-orphans.sh', ENV, { OS_CLEANUP_DRY_RUN: 'true' });
  assert.equal(dry.code, 0, dry.log);
  assert.match(dry.log, new RegExp(`= ${orphanCount} indices`));
  for (const s of ORPHAN_STREAMS) assert.ok(streams().has(s), `dry run deleted ${s}`);

  // The real run.
  const run = runJob('delete-orphans.sh', ENV);
  assert.equal(run.code, 0, run.log);
  const snapName = run.log.match(/Snapshot '(pre-orphan-cleanup-[0-9-]+)' SUCCESS/)?.[1];
  assert.ok(snapName, `no pre-delete snapshot reported:\n${run.log}`);
  const snap = os('GET', `/_snapshot/stackit-s3/${snapName}`).body.snapshots?.[0];
  assert.equal(snap?.state, 'SUCCESS');
  for (const i of ORPHAN_INDICES) assert.ok(snap.indices.includes(i), `snapshot lacks ${i}`);
  for (const s of ORPHAN_STREAMS) assert.ok((snap.data_streams ?? []).includes(s), `snapshot lacks data stream ${s}`);

  const after = names();
  const afterStreams = streams();
  for (const i of ORPHAN_INDICES) assert.ok(!after.has(i), `${i} survived`);
  for (const s of ORPHAN_STREAMS) assert.ok(!afterStreams.has(s), `data stream ${s} survived`);
  assert.ok(![...after].some((n) => /^\.ds-di-data-assets-(table|glossaryterm)-/.test(n)), 'a backing index survived');
  for (const i of DECOY_INDICES) assert.ok(after.has(i), `decoy ${i} was deleted`);
  for (const s of DECOY_STREAMS) assert.ok(afterStreams.has(s), `decoy data stream ${s} was deleted`);

  // Idempotent.
  const again = runJob('delete-orphans.sh', ENV);
  assert.equal(again.code, 0, again.log);
  assert.match(again.log, /Nothing to delete/);

  for (const i of DECOY_INDICES) os('DELETE', `/${i}`);
  for (const s of DECOY_STREAMS) os('DELETE', `/_data_stream/${s}`);
  os('DELETE', '/_index_template/wp21-it-streams');
});
