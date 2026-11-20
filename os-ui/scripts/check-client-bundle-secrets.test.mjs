/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       os-ui build tooling
 * FEATURE:    Refuse development secret defaults in production (defence in depth)
 * USER STORY: As an operator I want the client-bundle scan proven to fail when a development
 *             secret default is present, so a passing scan means something.
 * ARCHITECTURE:
 *   - Negative twin of check-client-bundle-secrets.mjs, run as a child process on synthetic
 *     bundles: FAILS on a chunk holding each default and on an empty or missing directory;
 *     passes a clean bundle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'check-client-bundle-secrets.mjs');
const run = (dir) => spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
const bundle = (content) => {
  const d = mkdtempSync(join(tmpdir(), 'bundle-'));
  mkdirSync(join(d, 'chunks'));
  writeFileSync(join(d, 'chunks', '1234-abc.js'), content);
  return d;
};

test('a clean bundle passes', () => {
  const r = run(bundle('self.__next_f.push([1,"hello"]);const k="";'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /none found/);
});

test('each development default in a chunk fails the scan, naming the setting and not the value', async () => {
  const src = readFileSync(resolve(dirname(script), '../core/kernel/dev-secret-defaults.ts'), 'utf8');
  const literals = [...src.matchAll(/SERVER \? '([^']+)'/g)].map((m) => m[1]);
  assert.ok(literals.length >= 4, 'dev-secret-defaults.ts literals not found');
  for (const literal of literals) {
    const r = run(bundle(`var a=${JSON.stringify(literal)};`));
    assert.equal(r.status, 1, `scan passed a bundle holding a default: ${r.stdout}`);
    assert.match(r.stderr, /chunks\/1234-abc\.js: dev-secret-defaults\.\w+/);
    assert.ok(!r.stderr.includes(literal), 'the report must not print the value');
  }
  const chart = run(bundle('var t="agent-runtime-local-dev-token";'));
  assert.equal(chart.status, 1);
  assert.match(chart.stderr, /values\.yaml agentRuntime\.token/);
});

test('a missing or empty directory fails: an empty scan proves nothing', () => {
  assert.equal(run(join(tmpdir(), 'no-such-bundle-dir-xyz')).status, 1);
  const empty = mkdtempSync(join(tmpdir(), 'bundle-empty-'));
  assert.equal(run(empty).status, 1);
});
