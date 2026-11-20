/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * os-snapshot.int.test (WP-21, design 02 step 3 / §7.1) — against the REAL image we ship
 * (images/extensions/opensearch: 3.7.0 + repository-s3), a REAL S3 store (SeaweedFS) and the
 * chart's own egress proxy, all configured from the rendered chart + STACKIT overlay.
 *
 *   1. register-s3.sh (the Job's script) registers `stackit-s3`, `_verify` passes THROUGH the
 *      proxy (its log shows the store host), and the SM policy `nightly` is applied (twice:
 *      idempotent update path).
 *   2. The SM policy itself takes a snapshot (`_explain` + `_snapshot/stackit-s3/_all`), and
 *      its objects are in the store, i.e. off-cluster.
 *   3. Restore of that snapshot into renamed indices gives equal document counts.
 *   Negative twin: with the proxy allowlist the chart renders WITHOUT the S3 feature (egress
 *   route missing), `_verify` fails and register-s3.sh exits non-zero.
 *
 * Run: bash tests/opensearch/up.sh && node --test tests/opensearch/os-snapshot.int.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { os, runJob, setProxy, proxyLog, storeObjects } from './harness.mjs';

const REPO = 'stackit-s3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('negative twin: no egress route to the store -> _verify fails, the Job fails', () => {
  setProxy('proxy-noroute');
  const r = runJob('register-s3.sh', 'register-opensearch-s3-repo.env');
  assert.notEqual(r.code, 0, `register-s3.sh must fail without the proxy route:\n${r.log}`);
  assert.match(r.log, /failed _verify|registration refused/, r.log);
  const v = os('POST', `/_snapshot/${REPO}/_verify`);
  assert.notEqual(v.status, 200, `verify must not pass without the route: ${JSON.stringify(v.body)}`);
});

test('register-s3.sh: repository verified through the egress proxy, SM policy applied idempotently', () => {
  setProxy('proxy');
  const first = runJob('register-s3.sh', 'register-opensearch-s3-repo.env');
  assert.equal(first.code, 0, first.log);
  assert.match(first.log, /Verified/);
  assert.match(first.log, /SM policy 'nightly' applied/);
  assert.match(proxyLog(), /object\.storage\.eu01\.onstackit\.cloud/, 'the store was reached via the proxy');
  const again = runJob('register-s3.sh', 'register-opensearch-s3-repo.env');
  assert.equal(again.code, 0, again.log);
  const repo = os('GET', `/_snapshot/${REPO}`);
  assert.equal(repo.body[REPO]?.type, 's3');
  const pol = os('GET', '/_plugins/_sm/policies/nightly');
  assert.equal(pol.status, 200);
  assert.equal(pol.body.sm_policy?.snapshot_config?.repository, REPO);
});

test('the SM policy snapshots to the store and a restore gives equal counts', { timeout: 15 * 60 * 1000 }, async () => {
  // Seed two OS-style indices the policy's patterns cover.
  const docs = { 'os-wp21-it': 25, 'files-wp21-it': 7 };
  for (const [idx, n] of Object.entries(docs)) {
    os('DELETE', `/${idx}`);
    const bulk = Array.from({ length: n }, (_, i) => `{"index":{"_index":"${idx}","_id":"${i}"}}\n{"n":${i},"t":"doc ${i}"}`).join('\n') + '\n';
    const b = os('POST', '/_bulk?refresh=true', bulk);
    assert.equal(b.status, 200, JSON.stringify(b.body));
  }
  // Wait for the policy (cron every minute in CI) to produce a SUCCESS snapshot.
  let snap;
  const until = Date.now() + 12 * 60 * 1000;
  while (Date.now() < until) {
    const all = os('GET', `/_snapshot/${REPO}/_all`);
    snap = (all.body.snapshots ?? []).find((s) => s.state === 'SUCCESS' && s.indices.includes('os-wp21-it') && s.indices.includes('files-wp21-it'));
    if (snap) break;
    await sleep(15_000);
  }
  assert.ok(snap, `no SUCCESS SM snapshot appeared: ${JSON.stringify(os('GET', '/_plugins/_sm/policies/nightly/_explain').body)}`);
  assert.equal(snap.metadata?.sm_policy, 'nightly', 'the snapshot was taken by Snapshot Management');
  const explain = os('GET', '/_plugins/_sm/policies/nightly/_explain');
  assert.equal(explain.status, 200);
  assert.ok(storeObjects('soa-ci-snapshots').includes('index-'), 'snapshot objects are in the S3 store');

  const rs = os('POST', `/_snapshot/${REPO}/${snap.snapshot}/_restore?wait_for_completion=true`, {
    indices: 'os-wp21-it,files-wp21-it', rename_pattern: '(.+)', rename_replacement: 'restored-$1', include_global_state: false,
  });
  assert.equal(rs.status, 200, JSON.stringify(rs.body));
  for (const [idx, n] of Object.entries(docs)) {
    os('POST', `/restored-${idx}/_refresh`);
    const c = os('GET', `/restored-${idx}/_count`);
    assert.equal(c.body.count, n, `restored-${idx}`);
    os('DELETE', `/restored-${idx}`);
  }
});
