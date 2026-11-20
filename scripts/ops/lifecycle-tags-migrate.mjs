#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// WP-51 — DRY-RUN migration of the pre-tag lifecycle records to native git tags.
//
// Before WP-51 a live pin was a row of `os/lifecycle/pins.yml` (plus an OpenSearch copy); its
// `tag: live/<kind>/<id>` named a ref that did not exist. Since WP-51 the pin IS the annotated tag
// `live/<kind>/<id>` and the file is a summary generated from the tags. Until each old row has its
// tag, os-ui honours it as `untagged` so nothing silently stops being Live.
//
// This script READS every bare repo under --repos with plain `git` and prints, per row that has
// no tag yet, the exact `git tag -a` commands that would give it one:
//   - the tag names the pinned commit when the row's ref is a sha the repo has, otherwise the last
//     commit on `main` at or before the row's `at` time (what was in the repo when it went live);
//   - the message carries the same trailers os-ui writes (OS-Action, OS-Object, OS-Ref, OS-Path,
//     OS-Actor), so os-ui reads the migrated tag exactly like one it wrote itself;
//   - `version/<kind>/<id>/1` is planned beside it, as a go-live writes.
// It writes NOTHING. `--apply` is refused on purpose: applying is an operator step, announced and
// run against a backup, never part of this work package.
//
// Usage: node scripts/ops/lifecycle-tags-migrate.mjs --repos /repos [--json]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--apply')) {
  console.error('refused: this migration is DRY-RUN only. Review the printed commands and run them as an announced operator step.');
  process.exit(2);
}
const reposIdx = args.indexOf('--repos');
const reposDir = reposIdx >= 0 ? args[reposIdx + 1] : '';
const asJson = args.includes('--json');
if (!reposDir || !fs.existsSync(reposDir)) {
  console.error('usage: lifecycle-tags-migrate.mjs --repos <dir of bare repos> [--json]');
  process.exit(1);
}

const KINDS = new Set(['dataset', 'metric', 'dashboard', 'agent', 'app', 'knowledge', 'connection']);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function git(gitDir, gitArgs) {
  try {
    return { ok: true, out: execFileSync('git', ['--git-dir', gitDir, ...gitArgs], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? '') };
  }
}

/** A YAML scalar as `renderPinFile` writes it: bare, or double-quoted. */
function scalar(v) {
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/**
 * The pin file is machine-written by os-ui (js-yaml dump of `{ version, domain, live: [...] }`),
 * so this reads exactly that shape and nothing more — no YAML dependency for an ops script.
 */
export function parsePinFile(text) {
  let version = 1;
  const rows = [];
  let cur = null;
  let inLive = false;
  for (const raw of String(text).split('\n')) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;
    const top = /^([A-Za-z_]+):\s*(.*)$/.exec(raw);
    if (top) {
      inLive = top[1] === 'live';
      if (top[1] === 'version') version = Number(scalar(top[2])) || 1;
      continue;
    }
    if (!inLive) continue;
    const item = /^\s*-\s+([A-Za-z_]+):\s*(.*)$/.exec(raw);
    const field = /^\s+([A-Za-z_]+):\s*(.*)$/.exec(raw);
    if (item) {
      cur = { [item[1]]: scalar(item[2]) };
      rows.push(cur);
    } else if (field && cur) {
      cur[field[1]] = scalar(field[2]);
    }
  }
  return { version, rows };
}

function repos(dir) {
  return fs
    .readdirSync(dir)
    .filter((e) => e.endsWith('.git'))
    .map((e) => path.join(dir, e))
    .filter((p) => !fs.lstatSync(p).isSymbolicLink() && fs.existsSync(path.join(p, 'HEAD')))
    .sort();
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const plan = [];
const skipped = [];
for (const gitDir of repos(reposDir)) {
  const repo = path.basename(gitDir, '.git');
  const file = git(gitDir, ['show', 'main:os/lifecycle/pins.yml']);
  if (!file.ok) continue;
  const { version, rows } = parsePinFile(file.out);
  const tagged = new Set(git(gitDir, ['for-each-ref', '--format=%(refname:strip=2)', 'refs/tags/live']).out.split('\n').filter(Boolean));
  for (const r of rows) {
    const name = `live/${r.kind}/${r.id}`;
    if (!KINDS.has(r.kind) || !SEGMENT.test(String(r.id ?? '')) || !r.ref) {
      skipped.push({ repo, row: r, reason: 'not a lifecycle row a tag can carry' });
      continue;
    }
    if (tagged.has(name)) {
      skipped.push({ repo, tag: name, reason: 'already tagged' });
      continue;
    }
    if (version >= 2 && r.tagged !== 'false') {
      skipped.push({ repo, tag: name, reason: 'a generated row whose tag was removed — not live, nothing to migrate' });
      continue;
    }
    let target = '';
    let how = '';
    if (/^[0-9a-f]{40}$/i.test(r.ref) && git(gitDir, ['cat-file', '-e', `${r.ref}^{commit}`]).ok) {
      target = r.ref.toLowerCase();
      how = 'the pinned commit';
    } else {
      const before = r.at ? git(gitDir, ['rev-list', '-1', `--before=${r.at}`, 'main']).out.trim() : '';
      target = before || git(gitDir, ['rev-parse', 'main']).out.trim();
      how = before ? `main as it was at ${r.at}` : 'main (no commit at or before the pin time)';
    }
    const trailers = [
      'OS-Action: migrate',
      `OS-Object: ${r.kind}:${r.id}`,
      `OS-Ref: ${r.ref}`,
      ...(r.path ? [`OS-Path: ${r.path}`] : []),
      `OS-Actor: ${r.by || 'migration'}`,
    ].join('\n');
    const base = `git --git-dir ${q(gitDir)} -c user.name='Sovereign OS' -c user.email=os@sovereign.local tag -a`;
    const msg = `-m ${q(`migrate ${r.kind}:${r.id}`)} -m ${q(trailers)}`;
    plan.push({
      repo,
      tag: name,
      version: `version/${r.kind}/${r.id}/1`,
      commit: target,
      how,
      ref: r.ref,
      commands: [`${base} ${q(name)} ${target} ${msg}`, `${base} ${q(`version/${r.kind}/${r.id}/1`)} ${target} ${msg}`],
    });
  }
}

if (asJson) {
  console.log(JSON.stringify({ dryRun: true, plan, skipped }, null, 2));
} else {
  console.log(`# DRY RUN — nothing was written. ${plan.length} tag(s) to create, ${skipped.length} row(s) skipped.`);
  for (const p of plan) {
    console.log(`\n# ${p.repo}: ${p.tag} -> ${p.commit.slice(0, 12)} (${p.how}); OS-Ref ${p.ref}`);
    for (const c of p.commands) console.log(c);
  }
  for (const s of skipped) console.log(`# skipped ${s.repo}: ${s.tag ?? JSON.stringify(s.row)} — ${s.reason}`);
}
