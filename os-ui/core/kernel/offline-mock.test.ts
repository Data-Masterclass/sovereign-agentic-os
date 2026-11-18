/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The offline-mock switch is a CLOSED allow-list keyed on the variable production sets
 * USER STORY: As a reviewer I want the one predicate that decides whether this deployment may
 *             fabricate to be provable in a table I can read in ten seconds — because the gate it
 *             replaces was keyed on `OS_PROFILE`, which nothing in the deploy ever set, and that
 *             mistake is invisible unless the truth table is written down and executed.
 * ARCHITECTURE:
 *   - Drives `offlineMockSetting` / `offlineMockAllowed` through their INJECTED arguments, so the
 *     table is exhaustive without mutating the process environment, and also once through
 *     `process.env` to prove the defaults really read it (the module must not snapshot).
 *   - Pins the refusal shapes too: a typed 503 / ENGINE_UNAVAILABLE error, and a refusal VALUE
 *     that carries no rows — those two are the contract every converted call site depends on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_UNAVAILABLE,
  OFFLINE_MOCK_ENV,
  OfflineMockRefusedError,
  isOfflineMockRefused,
  offlineMockAllowed,
  offlineMockRefusal,
  offlineMockSetting,
  refuseOfflineMock,
} from '@core/kernel/offline-mock';

test('UNSET + NODE_ENV=production ⇒ refuse — the whole point of the fix', () => {
  assert.equal(offlineMockSetting(undefined, 'production'), 'refuse');
  assert.equal(offlineMockAllowed(undefined, 'production'), false);
  assert.equal(offlineMockAllowed('', 'production'), false, 'an empty string is still unset');
  assert.equal(offlineMockAllowed('   ', 'production'), false, 'whitespace is still unset');
});

test('UNSET + a laptop / the test suite ⇒ allow — the teaching flow is byte-identical to before', () => {
  for (const env of ['development', 'test', undefined]) {
    assert.equal(offlineMockAllowed(undefined, env), true, `NODE_ENV=${String(env)}`);
  }
});

test('explicit `allow` allows in BOTH runtimes — the one way to switch fabrication on', () => {
  assert.equal(offlineMockAllowed('allow', 'production'), true);
  assert.equal(offlineMockAllowed('allow', 'development'), true);
  assert.equal(offlineMockAllowed(' allow ', 'production'), true, 'trimmed, so a YAML value with padding works');
});

test('explicit `refuse` refuses in BOTH runtimes — a laptop can opt INTO honesty', () => {
  assert.equal(offlineMockAllowed('refuse', 'production'), false);
  assert.equal(offlineMockAllowed('refuse', 'development'), false);
});

test('a CLOSED allow-list, not a boolean parse: anything but `allow` refuses', () => {
  // The `softwareBuilder` precedent in config.ts — a typo must never open the door, and the
  // likely typos are exactly the ones a boolean parse would have accepted.
  for (const v of ['true', 'yes', '1', 'on', 'ALLOW', 'Allow', 'allowed', 'mock', 'local', 'enable']) {
    assert.equal(offlineMockAllowed(v, 'production'), false, `${v} must not allow`);
    assert.equal(offlineMockAllowed(v, 'development'), false, `${v} must not allow in dev either`);
  }
});

test('the defaults READ process.env on every call (no frozen snapshot)', () => {
  const prevFlag = process.env[OFFLINE_MOCK_ENV];
  const prevNode = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env[OFFLINE_MOCK_ENV];
    assert.equal(offlineMockAllowed(), false, 'production + unset ⇒ refuse, read live');
    process.env[OFFLINE_MOCK_ENV] = 'allow';
    assert.equal(offlineMockAllowed(), true, 'the same call now allows — nothing was cached');
  } finally {
    if (prevFlag === undefined) delete process.env[OFFLINE_MOCK_ENV];
    else process.env[OFFLINE_MOCK_ENV] = prevFlag;
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else (process.env as Record<string, string>).NODE_ENV = prevNode;
  }
});

test('refuseOfflineMock throws a TYPED 503 / ENGINE_UNAVAILABLE naming what could not be computed', () => {
  assert.throws(
    () => refuseOfflineMock('Revenue cannot be computed: Trino is unreachable.'),
    (e: OfflineMockRefusedError) => {
      assert.equal(e.code, ENGINE_UNAVAILABLE);
      assert.equal(e.status, 503);
      assert.equal(e.name, 'OfflineMockRefusedError');
      assert.equal(e.reason, 'Revenue cannot be computed: Trino is unreachable.');
      assert.match(e.message, /Trino is unreachable/, 'the reason survives into the message');
      assert.match(e.message, new RegExp(OFFLINE_MOCK_ENV), 'the message names the switch that governs it');
      return true;
    },
  );
});

test('isOfflineMockRefused recognises the refusal by CODE, not by instanceof', () => {
  assert.equal(isOfflineMockRefused(new OfflineMockRefusedError('x')), true);
  // A structurally-equal error from another module instance (two bundles, one process) must match.
  assert.equal(isOfflineMockRefused({ code: ENGINE_UNAVAILABLE, message: 'x' }), true);
  assert.equal(isOfflineMockRefused(new Error('boom')), false);
  assert.equal(isOfflineMockRefused(undefined), false);
  assert.equal(isOfflineMockRefused(null), false);
  assert.equal(isOfflineMockRefused('ENGINE_UNAVAILABLE'), false, 'a bare string is not a refusal');
});

test('the refusal VALUE carries ok:false + the code and NO fabricated datum', () => {
  const r = offlineMockRefusal('No security scan ran.');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ENGINE_UNAVAILABLE');
  assert.equal(r.unavailable, true);
  assert.equal(r.reason, 'No security scan ran.');
  // The shape a caller may NOT find in here: anything that could be mistaken for a result.
  for (const forbidden of ['rows', 'row', 'value', 'rowCount', 'passed', 'table', 'findings', 'mode']) {
    assert.equal(forbidden in r, false, `the refusal must not carry \`${forbidden}\``);
  }
});
