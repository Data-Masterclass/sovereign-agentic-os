/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * WP-56 — git bundles and the git restore drill, against REAL git (backup-tools image) and a
 * REAL S3 store (SeaweedFS). Run: bash tests/backup/up.sh && node --test tests/backup/*.int.test.mjs
 *
 * Proves: full then incremental bundles, verified by git; the drill restores the chain, fscks
 * it and compares every ref with live. Negative twins: a corrupted bundle (both a byte flip and
 * a manifest rewritten to match a bad bundle), a missing bundle, a live repo with no bundle, an
 * empty world and a stale backup can NEVER report a pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tools, events, fresh, s3cat } from './harness.mjs';

// Shell building blocks, run inside backup-tools (paths are container paths under /work).
const commit = (t, repo, msg, branch = 'main') => `set -e
  R=/work/${t}/repos/${repo}.git; [ -d "$R" ] || { mkdir -p "$(dirname "$R")"; git init -q --bare -b main "$R"; }
  C=/tmp/c; rm -rf $C; git clone -q "$R" $C 2>&1 | grep -v "empty repository" || true; cd $C
  git checkout -q -B ${branch} $(git rev-parse -q --verify origin/${branch} || true)
  echo "${msg}" >> file.txt; git add file.txt; git commit -q -m "${msg}"; git push -q origin ${branch}`;
const inventory = (t) => `set -e; . /opt/soa/backup/lib.sh
  cd /work/${t}/repos; echo '{"repos":[]}' > /work/${t}/inv.json
  for g in $(find . -name '*.git' -type d -prune | sort); do k=\${g#./}; k=\${k%.git}
    refs_of "$g" | refs_json > /tmp/r.json
    jq --arg k "$k" --slurpfile r /tmp/r.json '.repos += [{key:$k, refs:$r[0]}]' /work/${t}/inv.json > /tmp/i && cp /tmp/i /work/${t}/inv.json
  done`;
const bundle = (t, repo) => `sh /opt/soa/backup/git-bundle.sh /work/${t}/repos/${repo}.git ${repo}`;
const drill = (t) => `mkdir -p /work/${t}/results && sh /opt/soa/backup/drill-git.sh`;
const env = (t, extra = {}) => ({ BUNDLE_PREFIX: `t-${t}`, RESULTS_DIR: `/work/${t}/results`, LIVE_INVENTORY_URL: `file:///work/${t}/inv.json`, DRILL_LAG_RETRIES: '0', ...extra });
const result = (dir) => JSON.parse(readFileSync(join(dir, 'results', 'git.json'), 'utf8'));
const run = (t, script, extra) => tools(script, env(t, extra));
/** A fresh test: its work dir AND its bucket prefixes are emptied (the store outlives a run). */
const start = (t) => {
  const d = fresh(t);
  const r = tools(`aws --endpoint-url "$S3_ENDPOINT" s3 rm --recursive --quiet s3://soa-bundles/t-${t}/ && aws --endpoint-url "$S3_ENDPOINT" s3 rm --recursive --quiet s3://soa-bundles/t-${t}-refs/ && aws --endpoint-url "$S3_ENDPOINT" s3 rm --recursive --quiet s3://soa-bundles/drills/t-${t}/`);
  assert.equal(r.code, 0, r.log);
  return d;
};
/** A setup step that must succeed (its log is the assertion message). */
const sh = (t, script, extra) => {
  const r = run(t, script, extra);
  assert.equal(r.code, 0, r.log);
  return r;
};

test('round-trip: full, then incremental bundles; the drill restores the chain and every ref equals live', () => {
  const t = 'roundtrip';
  const dir = start(t);
  assert.equal(sh(t, commit(t, 'sales', 'one')).code, 0);
  let r = run(t, bundle(t, 'sales'));
  assert.equal(r.code, 0, r.log);
  assert.equal(events(r.log).at(-1).type, 'full', r.log);

  // second commit + a new branch: incremental (the unchanged-ref case is the branch `keep` below)
  assert.equal(sh(t, commit(t, 'sales', 'two')).code, 0);
  assert.equal(sh(t, commit(t, 'sales', 'side', 'feature')).code, 0);
  r = run(t, bundle(t, 'sales'));
  assert.equal(events(r.log).at(-1).type, 'incremental', r.log);
  assert.equal(sh(t, commit(t, 'sales', 'three')).code, 0);
  r = run(t, bundle(t, 'sales'));
  const last = events(r.log).at(-1);
  assert.equal(last.type, 'incremental', r.log);
  assert.equal(last.chain, '3');

  // nothing moved → no new object
  r = run(t, bundle(t, 'sales'));
  assert.equal(events(r.log).at(-1).status, 'unchanged', r.log);

  // a nested repository key (repo-layout kinds, e.g. users/<id>) is handled the same way
  assert.equal(sh(t, commit(t, 'users/alex', 'mine')).code, 0);
  assert.equal(run(t, bundle(t, 'users/alex')).code, 0);

  const latest = JSON.parse(s3cat(`t-${t}/sales/latest`));
  assert.equal(latest.chain.length, 3);
  assert.deepEqual(Object.keys(latest.refs).sort(), ['refs/heads/feature', 'refs/heads/main']);

  assert.equal(sh(t, inventory(t)).code, 0);
  r = run(t, drill(t));
  const res = result(dir);
  assert.equal(res.status, 'pass', JSON.stringify(res, null, 1) + r.log);
  assert.deepEqual(res.repos.map((x) => x.repo).sort(), ['sales', 'users/alex']);
  assert.match(res.repos.find((x) => x.repo === 'sales').reason, /chain of 3 bundle\(s\) restored; fsck clean; 2 ref\(s\) equal live/);
});

test('a bundle verified by git: the manifest refs restore a ref whose tip did not move (git omits it from an incremental bundle)', () => {
  const t = 'keep';
  const dir = start(t);
  sh(t, commit(t, 'd', 'a'));
  sh(t, commit(t, 'd', 'k', 'keep'));
  run(t, bundle(t, 'd'));
  sh(t, commit(t, 'd', 'b'));
  const r = run(t, bundle(t, 'd'));
  assert.equal(events(r.log).at(-1).type, 'incremental');
  const heads = tools(`set -e; K=$(aws --endpoint-url "$S3_ENDPOINT" s3 cp s3://soa-bundles/t-${t}/d/latest - | jq -r .key)
    aws --endpoint-url "$S3_ENDPOINT" s3 cp "s3://soa-bundles/$K" /tmp/b --quiet; git bundle list-heads /tmp/b`, env(t));
  assert.equal(heads.code, 0, heads.log);
  assert.doesNotMatch(heads.log, /refs\/heads\/keep/, 'git omits the unchanged ref from the incremental bundle');
  sh(t, inventory(t));
  run(t, drill(t));
  assert.equal(result(dir).status, 'pass', JSON.stringify(result(dir)));
});

test('NEGATIVE: a corrupted bundle fails the drill (byte flip → sha256; rewritten manifest → git bundle verify)', () => {
  const t = 'corrupt';
  const dir = start(t);
  sh(t, commit(t, 'sales', 'one'));
  run(t, bundle(t, 'sales'));
  sh(t, inventory(t));
  run(t, drill(t));
  assert.equal(result(dir).status, 'pass', 'baseline must pass before corruption');

  // 1. flip bytes in the stored bundle
  const key = JSON.parse(s3cat(`t-${t}/sales/latest`)).key;
  let r = tools(`set -e; aws --endpoint-url "$S3_ENDPOINT" s3 cp "s3://soa-bundles/${key}" /tmp/b --quiet
    printf 'XXXXXXXX' | dd of=/tmp/b bs=1 seek=200 conv=notrunc 2>/dev/null
    aws --endpoint-url "$S3_ENDPOINT" s3 cp /tmp/b "s3://soa-bundles/${key}" --quiet`, env(t));
  assert.equal(r.code, 0, r.log);
  run(t, drill(t));
  let res = result(dir);
  assert.equal(res.status, 'fail');
  assert.match(res.repos[0].reason, /sha256 mismatch/);

  // 2. an attacker (or a bug) also rewrites the manifest's sha256 to match: git itself refuses it
  r = tools(`set -e; aws --endpoint-url "$S3_ENDPOINT" s3 cp "s3://soa-bundles/${key}" /tmp/b --quiet
    S=$(openssl dgst -sha256 -r /tmp/b | cut -d' ' -f1)
    aws --endpoint-url "$S3_ENDPOINT" s3 cp s3://soa-bundles/t-${t}/sales/latest - | jq --arg s "$S" '.chain[-1].sha256=$s' > /tmp/l
    aws --endpoint-url "$S3_ENDPOINT" s3 cp /tmp/l s3://soa-bundles/t-${t}/sales/latest --quiet`, env(t));
  assert.equal(r.code, 0, r.log);
  run(t, drill(t));
  res = result(dir);
  assert.equal(res.status, 'fail');
  assert.match(res.repos[0].reason, /git bundle verify failed|git fetch .* failed|fsck/);
});

test('NEGATIVE TWIN: a drill can never pass on a missing bundle, an unbacked live repo, an empty world or a stale backup', () => {
  // a) a bundle of the chain is gone
  let t = 'missing';
  let dir = start(t);
  sh(t, commit(t, 'sales', 'one'));
  run(t, bundle(t, 'sales'));
  sh(t, commit(t, 'sales', 'two'));
  run(t, bundle(t, 'sales'));
  const first = JSON.parse(s3cat(`t-${t}/sales/latest`)).chain[0].key;
  assert.equal(tools(`aws --endpoint-url "$S3_ENDPOINT" s3 rm "s3://soa-bundles/${first}"`, env(t)).code, 0);
  sh(t, inventory(t));
  run(t, drill(t));
  let res = result(dir);
  assert.equal(res.status, 'fail');
  assert.match(res.repos[0].reason, /bundle missing/);

  // b) a live repository that was never bundled
  t = 'unbacked';
  dir = start(t);
  sh(t, commit(t, 'sales', 'one'));
  sh(t, inventory(t));
  run(t, drill(t));
  res = result(dir);
  assert.equal(res.status, 'fail');
  assert.match(res.repos[0].reason, /no latest pointer/);

  // c) nothing at all: no live repo, no bundle — not a pass
  t = 'empty';
  dir = start(t);
  tools(`mkdir -p /work/${t}/repos`, env(t));
  sh(t, inventory(t));
  run(t, drill(t));
  res = result(dir);
  assert.equal(res.status, 'fail');
  assert.match(res.reason, /nothing was proven/);

  // d) live moved on and no bundle followed: restored refs differ from live
  t = 'stale';
  dir = start(t);
  sh(t, commit(t, 'sales', 'one'));
  run(t, bundle(t, 'sales'));
  sh(t, commit(t, 'sales', 'two'));
  sh(t, inventory(t));
  run(t, drill(t));
  res = result(dir);
  assert.equal(res.status, 'fail');
  assert.match(res.repos[0].reason, /differ from live/);

  // e) the live inventory is unreadable
  t = 'noinv';
  dir = start(t);
  run(t, drill(t), { LIVE_INVENTORY_URL: 'file:///work/noinv/absent.json' });
  res = result(dir);
  assert.equal(res.status, 'fail');
  assert.match(res.reason, /inventory unreadable/);
});

test('the reporter fails a drill whose check produced no result, and a pass needs every expected check', () => {
  const t = 'report';
  const dir = start(t);
  tools(`mkdir -p /work/${t}/results && echo '{"check":"git","status":"pass","reason":"ok"}' > /work/${t}/results/git.json`, env(t));
  let r = tools('sh /opt/soa/backup/drill-report.sh', env(t, { DRILL_CHECKS: 'git postgres', DRILL_KIND: `t-${t}` }));
  assert.notEqual(r.code, 0, 'a missing postgres result must fail the Job');
  let rep = events(r.log).find((e) => e.event === 'restore-drill-report');
  assert.equal(rep.status, 'fail');
  assert.match(JSON.stringify(rep.checks), /no result/);
  r = tools('sh /opt/soa/backup/drill-report.sh', env(t, { DRILL_CHECKS: 'git', DRILL_KIND: `t-${t}` }));
  assert.equal(r.code, 0, r.log);
  rep = JSON.parse(s3cat(`drills/t-${t}/latest`));
  assert.equal(rep.status, 'pass');
  void dir;
});

test('tamper evidence: the hourly ref record is hash-chained to the one before it', () => {
  const t = 'refs';
  start(t);
  sh(t, commit(t, 'sales', 'one'));
  const e = { REPOS_DIR: `/work/${t}/repos`, REFS_PREFIX: `t-${t}-refs` };
  let r = tools('sh /opt/soa/backup/git-refs-record.sh', env(t, e));
  assert.equal(r.code, 0, r.log);
  const firstSha = events(r.log).at(-1).sha256;
  sh(t, commit(t, 'sales', 'two'));
  r = tools('sh /opt/soa/backup/git-refs-record.sh', env(t, e));
  assert.equal(r.code, 0, r.log);
  const rec = JSON.parse(s3cat(`t-${t}-refs/latest`));
  assert.equal(rec.prev.sha256, firstSha);
  assert.ok(rec.repos.sales['refs/heads/main']);
});
