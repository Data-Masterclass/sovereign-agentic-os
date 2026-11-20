// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// WP-51: the lifecycle tag migration is a DRY RUN. Against real bare repos it plans a tag for
// every pre-tag pin row, skips rows that already have one, writes nothing, refuses --apply — and
// the commands it prints, run by hand on a COPY, produce tags git reads back with the same OS-Ref.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(import.meta.dirname, '..', 'ops', 'lifecycle-tags-migrate.mjs');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (args, cwd) => execFileSync('git', args, { env, cwd, encoding: 'utf8' });

function seed() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wp51-migrate-'));
  const repos = path.join(base, 'repos');
  const src = path.join(base, 'src');
  fs.mkdirSync(repos);
  git(['init', '-q', '-b', 'main', src]);
  fs.writeFileSync(path.join(src, 'a.txt'), 'a\n');
  git(['add', 'a.txt'], src);
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-qm', 'one'], {
    env: { ...env, GIT_AUTHOR_DATE: '2026-11-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-01T00:00:00Z' },
    cwd: src,
  });
  const first = git(['rev-parse', 'HEAD'], src).trim();
  fs.mkdirSync(path.join(src, 'os/lifecycle'), { recursive: true });
  fs.writeFileSync(
    path.join(src, 'os/lifecycle/pins.yml'),
    [
      '# a pre-WP-51 pin file',
      'version: 1',
      'domain: sales',
      'live:',
      '  - kind: agent',
      '    id: bot',
      `    ref: ${first}`,
      '    tag: live/agent/bot',
      '    at: "2026-11-02T00:00:00.000Z"',
      '    by: alice@example.com',
      '    path: agents/bot/system.yaml',
      '  - kind: dataset',
      '    id: ds_orders',
      '    ref: rev:0123456789ab',
      '    tag: live/dataset/ds_orders',
      '    at: "2026-11-02T00:00:00.000Z"',
      '    by: alice@example.com',
      '  - kind: dashboard',
      '    id: dash_done',
      '    ref: spec:abc',
      '    tag: live/dashboard/dash_done',
      '    at: "2026-11-02T00:00:00.000Z"',
      '    by: bob@example.com',
      '',
    ].join('\n'),
  );
  git(['add', '.'], src);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-qm', 'pins'], src);
  const bare = path.join(repos, 'sales.git');
  git(['clone', '-q', '--bare', src, bare]);
  // One row already has its tag.
  git(['--git-dir', bare, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'tag', '-a', 'live/dashboard/dash_done', '-m', 'x', 'main']);
  return { base, repos, bare, first };
}

const refsOf = (bare) => git(['--git-dir', bare, 'for-each-ref', '--format=%(refname) %(objectname)']);

test('dry run: plans the untagged rows, skips the tagged one, and writes NOTHING', () => {
  const { base, repos, bare, first } = seed();
  try {
    const before = refsOf(bare);
    const out = JSON.parse(execFileSync('node', [SCRIPT, '--repos', repos, '--json'], { env, encoding: 'utf8' }));
    assert.equal(out.dryRun, true);
    assert.deepEqual(out.plan.map((p) => p.tag).sort(), ['live/agent/bot', 'live/dataset/ds_orders']);
    assert.equal(out.plan.find((p) => p.tag === 'live/agent/bot').commit, first, 'a sha the repo has is tagged itself');
    assert.equal(out.plan.find((p) => p.tag === 'live/dataset/ds_orders').commit, first, 'a content ref tags main as it was at the pin time');
    assert.ok(out.skipped.some((s) => s.tag === 'live/dashboard/dash_done' && /already tagged/.test(s.reason)));
    assert.equal(refsOf(bare), before, 'no ref changed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('negative twin: --apply is refused and changes nothing', () => {
  const { base, repos, bare } = seed();
  try {
    const before = refsOf(bare);
    const r = spawnSync('node', [SCRIPT, '--repos', repos, '--apply'], { env, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /DRY-RUN only/);
    assert.equal(refsOf(bare), before);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the printed commands, run by hand on a COPY, give tags whose OS-Ref git reads back', () => {
  const { base, repos } = seed();
  try {
    const copy = path.join(base, 'copy');
    fs.cpSync(repos, copy, { recursive: true });
    const out = JSON.parse(execFileSync('node', [SCRIPT, '--repos', copy, '--json'], { env, encoding: 'utf8' }));
    for (const p of out.plan) for (const c of p.commands) execFileSync('sh', ['-c', c], { env });
    const read = git(['--git-dir', path.join(copy, 'sales.git'), 'for-each-ref', '--format=%(refname:strip=2) %(trailers:key=OS-Ref,valueonly,separator=)', 'refs/tags/live', 'refs/tags/version']);
    assert.match(read, /^live\/agent\/bot [0-9a-f]{40}$/m);
    assert.match(read, /^live\/dataset\/ds_orders rev:0123456789ab$/m);
    assert.match(read, /^version\/dataset\/ds_orders\/1 rev:0123456789ab$/m);
    // And the original was never touched.
    assert.equal(git(['--git-dir', path.join(repos, 'sales.git'), 'tag', '-l', 'version/*']).trim(), '');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
