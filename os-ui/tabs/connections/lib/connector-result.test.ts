/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    One shape for every connector read — and a page limit that is said, not implied
 * USER STORY: As an agent reading Slack, GitHub, Gmail or Notion through a governed connection I
 *             want a read that stopped at the connector's page limit to tell me how many rows came
 *             back and that the source holds more, so "the first 250" is never taken for "all".
 * ARCHITECTURE:
 *   - `connectorDone` is the single result shaper `executeGithub`/`executeSlack`/… use (it replaced
 *     16 inline copies). Pure; the clients' own paging is covered in their client tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectorDone } from '@tabs/connections/lib/store';

const fail = (reason: string) => ({ connection: 'gh', ok: false, reason });

test('a complete read is just the rows', () => {
  assert.deepEqual(connectorDone('gh', fail)({ ok: true, data: [1, 2] }, 'issues'), { connection: 'gh', issues: [1, 2] });
});

test('a read cut at the page limit says how many came back and that there are more', () => {
  const out = connectorDone('gh', fail)({ ok: true, data: [1, 2, 3], truncated: true }, 'issues') as Record<string, unknown>;
  assert.equal(out.truncated, true);
  assert.equal(out.returned, 3);
  assert.match(String(out.note), /first 3 of the issues came back: the source holds more/);
});

test('a failure stays a failure', () => {
  assert.deepEqual(connectorDone('gh', fail)({ ok: false, reason: 'nope' }, 'issues'), { connection: 'gh', ok: false, reason: 'nope' });
});
