/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * WP-56 — the OpenSearch restore drill against the REAL image we ship (WP-21: 3.7.0 +
 * repository-s3), SeaweedFS as the S3 store and the chart's egress proxy — the WP-21 stack:
 *   bash tests/opensearch/up.sh && node --test tests/backup/os-drill.int.test.mjs
 * The repository is registered by the chart's own register-s3.sh; the drill script runs in the
 * curl image with the chart's ONE OpenSearch shell client, exactly as the CronJob runs it.
 *
 * Proves: the newest snapshot is restored under a temporary prefix, the copies' document counts
 * equal live, and the temporary indices are gone afterwards. Negative twins: a repository with
 * no snapshot, and a live index that no longer exists, can never pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { os, runJob, P, WORK } from '../opensearch/harness.mjs';
import { runRendered, emptyDir } from './rendered.mjs';

const REPO = 'stackit-s3';

/** The RENDERED os-drill initContainer: its command, env, uid, read-only root, EMPTY /work and /tmp. */
function drill(name, extra = {}) {
  const base = join(WORK, 'wp56', name);
  const work = emptyDir(join(base, 'work'));
  const r = runRendered('os-drill', {
    network: `${P}-os`,
    dirs: { '/work': work, '/tmp': emptyDir(join(base, 'tmp')) },
    env: { OPENSEARCH_URL: 'http://opensearch:9200', OS_WAIT_TRIES: '5', OS_DRILL_INDICES: 'wp56-*', ...extra },
  });
  assert.equal(r.code, 0, r.log);
  return { res: JSON.parse(readFileSync(join(work, 'results', 'opensearch.json'), 'utf8')), log: r.log };
}

test('setup: the S3 repository registered by the chart script', () => {
  const r = runJob('register-s3.sh', 'register-opensearch-s3-repo.env');
  assert.equal(r.code, 0, r.log);
});

test('NEGATIVE: a repository with no snapshot is a failure', () => {
  const body = { type: 's3', settings: { bucket: 'soa-ci-snapshots', base_path: `wp56-empty-${Date.now()}` } };
  assert.equal(os('PUT', '/_snapshot/wp56-empty', body).status, 200);
  const { res } = drill('empty', { OS_DRILL_REPO: 'wp56-empty' });
  assert.equal(res.status, 'fail');
  assert.match(res.reason, /no successful snapshot/);
});

test('the newest snapshot restores under a temporary prefix; counts equal live; temp indices removed', () => {
  const docs = { 'wp56-os-it': 25, 'wp56-files-it': 7 };
  for (const [idx, n] of Object.entries(docs)) {
    os('DELETE', `/${idx}`);
    const bulk = Array.from({ length: n }, (_, i) => `{"index":{"_index":"${idx}","_id":"${i}"}}\n{"n":${i}}`).join('\n') + '\n';
    assert.equal(os('POST', '/_bulk?refresh=true', bulk).status, 200);
  }
  const s = os('PUT', `/_snapshot/${REPO}/wp56-drill-${Date.now()}?wait_for_completion=true`, { indices: 'wp56-*', include_global_state: false });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.snapshot?.state, 'SUCCESS');

  const { res, log } = drill('ok');
  assert.equal(res.status, 'pass', JSON.stringify(res) + log);
  assert.equal(res.snapshot, s.body.snapshot.snapshot);
  const by = Object.fromEntries(res.indices.map((i) => [i.index, i]));
  assert.equal(by['wp56-os-it'].restored, 25);
  assert.equal(by['wp56-os-it'].live, 25);
  assert.equal(by['wp56-files-it'].restored, 7);
  const left = os('GET', '/_cat/indices/drill-*?format=json');
  assert.deepEqual(left.body, [], 'the temporary indices are deleted');
});

test('NEGATIVE: a snapshot older than the age limit fails', () => {
  const { res } = drill('stale', { OS_DRILL_MAX_AGE_HOURS: '-1' });
  assert.equal(res.status, 'fail');
  assert.match(res.reason, /above the -1 h limit/);
});

test('NEGATIVE: a snapshot that ends in the future (beyond the clock slack) fails', () => {
  // A real snapshot ends ~now; a NEGATIVE slack puts "now" behind it, as a wrong clock would.
  const { res } = drill('future', { DRILL_CLOCK_SLACK_SECONDS: '-86400' });
  assert.equal(res.status, 'fail', JSON.stringify(res));
  assert.match(res.reason, /in the future, beyond the -86400 s clock slack/);
});

test('NEGATIVE: a live index created after the snapshot (missing from it) fails', () => {
  const bulk = '{"index":{"_index":"wp56-new-it","_id":"1"}}\n{"n":1}\n';
  assert.equal(os('POST', '/_bulk?refresh=true', bulk).status, 200);
  const { res } = drill('newlive');
  assert.equal(res.status, 'fail', JSON.stringify(res));
  assert.match(JSON.stringify(res.indices), /wp56-new-it.*missing from snapshot/);
  os('DELETE', '/wp56-new-it');
});

test('NEGATIVE TWIN: a renamed index (old name now an alias of the new one) fails both ways', () => {
  assert.equal(os('POST', '/_reindex?refresh=true', { source: { index: 'wp56-os-it' }, dest: { index: 'wp56-os-v2' } }).status, 200);
  assert.equal(os('DELETE', '/wp56-os-it').status, 200);
  assert.equal(os('POST', '/_aliases', { actions: [{ add: { index: 'wp56-os-v2', alias: 'wp56-os-it' } }] }).status, 200);
  const { res } = drill('renamed');
  assert.equal(res.status, 'fail', JSON.stringify(res));
  const by = Object.fromEntries(res.indices.map((i) => [i.index, i]));
  assert.match(by['wp56-os-it'].reason, /no longer a concrete live index/);
  assert.match(by['wp56-os-v2'].reason, /missing from snapshot/);
  os('DELETE', '/wp56-os-v2'); // the alias goes with it; put the original index back
  const bulk = Array.from({ length: 25 }, (_, i) => `{"index":{"_index":"wp56-os-it","_id":"${i}"}}\n{"n":${i}}`).join('\n') + '\n';
  assert.equal(os('POST', '/_bulk?refresh=true', bulk).status, 200);
});

test('NEGATIVE: a live index missing since the snapshot fails the drill', () => {
  os('DELETE', '/wp56-files-it');
  const { res } = drill('gone');
  assert.equal(res.status, 'fail');
  assert.equal(res.indices.find((i) => i.index === 'wp56-files-it').status, 'fail');
  assert.match(res.reason, /1 of 2/);
});
