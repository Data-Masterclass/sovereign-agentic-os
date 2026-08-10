/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  accessCap,
  accessToCapability,
  capabilityToAccess,
  allowedAccessLevels,
  clampAccess,
  AGENT_SAFETY_PRESETS,
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

/* ── item 6b: unified, honest agent safety-preset copy ──────────────────── */

test('AGENT_SAFETY_PRESETS: read-propose maps to the Write-approval capability (all writes held)', () => {
  const rp = AGENT_SAFETY_PRESETS.find((p) => p.id === 'read-propose')!;
  assert.ok(rp, 'read-propose preset exists');
  // The runtime truth: read-propose ↔ Write-approval (every write held for approval).
  assert.equal(accessToCapability('read-propose'), 'Write-approval');
  // The copy must be HONEST: it must NOT claim any write runs directly. The old
  // SimpleBuilder copy ("My scope run directly") was factually wrong.
  assert.doesNotMatch(rp.consequence, /run directly|runs directly/i,
    'read-propose must not claim any write runs directly — Write-approval holds them all');
  assert.match(rp.consequence, /approve/i, 'the honest copy names the human approval');
});

test('AGENT_SAFETY_PRESETS: covers all four presets with labels + consequences', () => {
  assert.deepEqual(
    AGENT_SAFETY_PRESETS.map((p) => p.id),
    ['read-only', 'read-propose', 'read-bounded', 'full-in-scope'],
  );
  for (const p of AGENT_SAFETY_PRESETS) {
    assert.ok(p.label.length > 0, `${p.id} has a label`);
    assert.ok(p.consequence.length > 0, `${p.id} has a consequence`);
  }
});

test('both agent builders use the ONE shared AGENT_SAFETY_PRESETS const (no divergent copies)', () => {
  const runtimeSel = readFileSync(new URL('../../components/agents/RuntimeSelector.tsx', import.meta.url), 'utf8');
  const simpleBuilder = readFileSync(new URL('../../components/agents/SimpleBuilder.tsx', import.meta.url), 'utf8');
  for (const [name, src] of [['RuntimeSelector', runtimeSel], ['SimpleBuilder', simpleBuilder]] as const) {
    assert.match(src, /AGENT_SAFETY_PRESETS/, `${name} references the shared preset const`);
    // The old inline, hand-written consequence strings must be gone.
    assert.doesNotMatch(src, /My scope run directly/, `${name} no longer carries the contradictory copy`);
  }
});
