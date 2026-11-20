/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Tests of the expected-fail and negative-twin semantics (no cluster needed)
 * USER STORY: As the verifier I want proof that the red-first marker cannot hide a green assertion
 *             and that a twin which cannot see its hop fails the run.
 * ARCHITECTURE:
 *   - Runs each fixture in its own `node --test` child with a fresh report dir and checks the exit
 *     code and the recorded status.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runFixture(name) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-fx-'));
  const { NODE_TEST_CONTEXT, ...env } = process.env; // a nested `node --test` must not report into this run
  const r = spawnSync(process.execPath, ['--test', join(import.meta.dirname, 'fixtures', name)], { env: { ...env, E2E_REPORT_DIR: dir, E2E_IGNORE_XFAIL: '' }, encoding: 'utf8' });
  const rows = readFileSync(join(dir, 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { code: r.status, status: rows[0].status, reason: rows[0].reason };
}

test('expected-fail + red passes the run and is reported red', () => {
  const r = runFixture('xfail-red.mjs');
  assert.equal(r.code, 0);
  assert.equal(r.status, 'red');
  assert.match(r.reason, /not there yet/);
});

test('expected-fail + green FAILS the run (unexpected-green)', () => {
  const r = runFixture('xfail-green.mjs');
  assert.notEqual(r.code, 0);
  assert.equal(r.status, 'unexpected-green');
});

test('a twin that stays green with its hop disabled FAILS the run', () => {
  const r = runFixture('twin-blind.mjs');
  assert.notEqual(r.code, 0);
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /stayed GREEN/);
});

test('a twin that turns red for the required reason passes', () => {
  const r = runFixture('twin-sees.mjs');
  assert.equal(r.code, 0);
  assert.equal(r.status, 'green');
});
