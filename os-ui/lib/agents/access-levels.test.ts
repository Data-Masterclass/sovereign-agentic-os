/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accessCap,
  accessToCapability,
  capabilityToAccess,
  allowedAccessLevels,
  clampAccess,
  type AccessLevel,
} from './access-levels.ts';

/**
 * The per-item access-level cap logic: the three levels map onto the ONE grant
 * capability model, and the agent-system-wide safety preset caps every item —
 * locked at the extremes, downgrade-only in the middle.
 */

test('access levels map 1:1 onto the grant capability model', () => {
  assert.equal(accessToCapability('read-only'), 'Read');
  assert.equal(accessToCapability('read-propose'), 'Write-approval');
  assert.equal(accessToCapability('read-write'), 'Write-bounded');
  // Round-trip both ways.
  const levels: AccessLevel[] = ['read-only', 'read-propose', 'read-write'];
  for (const l of levels) assert.equal(capabilityToAccess(accessToCapability(l)), l);
  // Off/Blocked collapse to read-only.
  assert.equal(capabilityToAccess('Off'), 'read-only');
  assert.equal(capabilityToAccess('Blocked'), 'read-only');
});

test('system read-only → locked read-only for every item', () => {
  const cap = accessCap('read-only');
  assert.equal(cap.locked, true);
  assert.equal(cap.ceiling, 'read-only');
  assert.equal(cap.default, 'read-only');
  assert.match(cap.reason, /read-only/i);
  // Only read-only is offerable.
  assert.deepEqual(allowedAccessLevels(cap), ['read-only']);
  // Any desired level is clamped down to read-only.
  assert.equal(clampAccess('read-write', cap), 'read-only');
  assert.equal(clampAccess('read-propose', cap), 'read-only');
});

test('system full-in-scope → locked read+write for every item', () => {
  const cap = accessCap('full-in-scope');
  assert.equal(cap.locked, true);
  assert.equal(cap.ceiling, 'read-write');
  assert.equal(cap.default, 'read-write');
  assert.match(cap.reason, /full-in-scope/i);
  // Locked forces the ceiling even for a weaker desired level.
  assert.equal(clampAccess('read-only', cap), 'read-write');
  assert.equal(clampAccess('read-propose', cap), 'read-write');
});

test('system read-propose → default read+propose, downgrade-only (never upgrade)', () => {
  const cap = accessCap('read-propose');
  assert.equal(cap.locked, false);
  assert.equal(cap.ceiling, 'read-propose');
  assert.equal(cap.default, 'read-propose');
  // Offerable: read-only + read-propose, NOT read-write.
  assert.deepEqual(allowedAccessLevels(cap), ['read-only', 'read-propose']);
  // A downgrade is honoured; an attempted upgrade is clamped to the ceiling.
  assert.equal(clampAccess('read-only', cap), 'read-only');
  assert.equal(clampAccess('read-propose', cap), 'read-propose');
  assert.equal(clampAccess('read-write', cap), 'read-propose');
});

test('system read-bounded → ceiling read+write, downgrade-only', () => {
  const cap = accessCap('read-bounded');
  assert.equal(cap.locked, false);
  assert.equal(cap.ceiling, 'read-write');
  assert.equal(cap.default, 'read-write');
  assert.deepEqual(allowedAccessLevels(cap), ['read-only', 'read-propose', 'read-write']);
  // Nothing to clamp — the ceiling is the top level.
  assert.equal(clampAccess('read-only', cap), 'read-only');
  assert.equal(clampAccess('read-write', cap), 'read-write');
});
