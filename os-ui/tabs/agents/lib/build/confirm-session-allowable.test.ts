/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    "Allow for this conversation" may never cover a tool the agent hold gate confirms,
 *             escalates or routes to an admin.
 * USER STORY: As the owner I want the conversation allowance to cover creating my own work only —
 *             so the set it is drawn from must stay clear of everything the hold gate treats as
 *             destructive, boundary-crossing or an approval, including tools added there later.
 * ARCHITECTURE: lives in this tab because `hold.ts` does, and a core test may not import a tab.
 *             It asks `hold.ts` through its exported functions, so it follows that file's sets
 *             without needing them exported (and without editing it).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_ALLOWABLE_TOOLS, isSessionAllowable } from '@core/mcp/tool-classes';
import { WRITE_TOOL_NAMES } from '@core/mcp/write-tool-meta';
import { writeTargetScope, holdReason, holdDecision } from '@tabs/agents/lib/build/hold';

test('SESSION_ALLOWABLE_TOOLS is disjoint from ALWAYS_CONFIRMED_TOOLS and from every escalating or company-scope tool', () => {
  for (const name of Object.keys(SESSION_ALLOWABLE_TOOLS)) {
    assert.equal(holdReason(name).label, 'personal-scope', `${name}: the hold gate labels it '${holdReason(name).label}'`);
    assert.equal(writeTargetScope(name), 'personal', `${name} must be a My-scope write`);
    assert.deepEqual(holdDecision('full-in-scope', name), { held: false }, `${name} is held for a second person on the engine path`);
  }
});

test('the direction that matters most: no always-confirmed, escalating or admin-decided tool is session-allowable', () => {
  // Derived from the write catalog, so a tool that `hold.ts` starts confirming tomorrow is covered
  // here without anyone remembering to list it.
  const guarded = [...WRITE_TOOL_NAMES].filter((n) => writeTargetScope(n) !== 'personal');
  assert.ok(guarded.length >= 15, 'the hold gate still guards the families this test exists for');
  for (const name of ['delete', 'archive', 'request_deploy', 'retire_connection', 'request_certification', 'update_operating_manual', 'restore_operating_manual_version']) {
    assert.ok(guarded.includes(name), `${name} is expected to be always-confirmed in hold.ts`);
  }
  for (const name of guarded) assert.equal(isSessionAllowable(name), false, `${name} must never be allowable for a conversation`);
});
