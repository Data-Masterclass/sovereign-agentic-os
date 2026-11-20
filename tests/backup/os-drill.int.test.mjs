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
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { os, runJob, P, WORK } from '../opensearch/harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = join(ROOT, 'charts', 'sovereign-agentic-os', 'files');
const REPO = 'stackit-s3';

function drill(name, extra = {}) {
  const res = join(WORK, 'wp56', name);
  rmSync(res, { recursive: true, force: true });
  mkdirSync(res, { recursive: true });
  spawnSync('chmod', ['-R', 'a+rwX', join(WORK, 'wp56')]);
  const args = ['run', '--rm', '--network', `${P}-os`, '--user', '100:100',
    '-v', `${join(FILES, 'opensearch', 'lib')}:/opt/soa/lib:ro`, '-v', `${join(FILES, 'backup')}:/opt/soa/backup:ro`, '-v', `${res}:/results`,
    '-e', 'OPENSEARCH_URL=http://opensearch:9200', '-e', 'OS_WAIT_TRIES=5', '-e', 'RESULTS_DIR=/results', '-e', `OS_DRILL_REPO=${REPO}`,
    '-e', 'OS_DRILL_INDICES=wp56-*'];
  for (const [k, v] of Object.entries(extra)) args.push('-e', `${k}=${v}`);
  args.push('--entrypoint', '/bin/sh', 'curlimages/curl:8.8.0', '/opt/soa/backup/drill-opensearch.sh');
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return { res: JSON.parse(readFileSync(join(res, 'opensearch.json'), 'utf8')), log: r.stdout + r.stderr };
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

test('NEGATIVE: a live index missing since the snapshot fails the drill', () => {
  os('DELETE', '/wp56-files-it');
  const { res } = drill('gone');
  assert.equal(res.status, 'fail');
  assert.equal(res.indices.find((i) => i.index === 'wp56-files-it').status, 'fail');
  assert.match(res.reason, /1 of 2/);
});
