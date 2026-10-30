/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests for where the Drive/OneDrive OAuth callback sends the user,
 *             and for the provider error code it forwards.
 *
 * USER STORY: As someone connecting OneDrive, finishing consent must land me on
 *             the Files tab — not on a 404. And when it fails I need the
 *             provider's actual code, because "exchange_failed" cannot tell a
 *             mistyped client secret from an unreachable token endpoint.
 *
 * ARCHITECTURE:
 *   The landing path is pinned against the NAV definition rather than restated,
 *   because the original bug was exactly a drift between them: the callback sent
 *   everyone to `/files`, which exists only as an API path and has no page, so
 *   all eight exits of that route — success included — ended on a 404.
 *   `safeErrorCode` is tested for what it must NOT forward as much as for what
 *   it must: a free-text provider body never reaches the URL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILES_LANDING_PATH, safeErrorCode } from './drive-landing.ts';
import { TABS } from '@core/kernel/tabs';

test('OAUTH-LANDING: the callback lands on the Files tab’s REAL route', () => {
  const files = TABS.find((t) => t.feature === 'files');
  assert.ok(files, 'the Files tab must exist in the nav');
  assert.equal(FILES_LANDING_PATH, files.href);
  assert.equal(FILES_LANDING_PATH, '/unstructured', 'the real route today');
});

test('OAUTH-LANDING: and that route is not /files, which has no page', () => {
  assert.notEqual(FILES_LANDING_PATH, '/files');
});

test('OAUTH-LANDING: an Entra code survives, because it names the cause', () => {
  assert.equal(safeErrorCode('AADSTS7000215: Invalid client secret provided.'), 'AADSTS7000215');
  assert.equal(safeErrorCode('AADSTS50194: not configured as multi-tenant'), 'AADSTS50194');
});

test('OAUTH-LANDING: a standard OAuth code survives', () => {
  assert.equal(safeErrorCode('{"error":"invalid_client","x":1}'), 'invalid_client');
  assert.equal(safeErrorCode('the grant is invalid_grant here'), 'invalid_grant');
});

test('OAUTH-LANDING: free text is NOT forwarded — only a matched code', () => {
  assert.equal(safeErrorCode('Something went terribly wrong at 10:42 for user alex'), '');
  assert.equal(safeErrorCode(''), '');
  assert.equal(safeErrorCode('client_secret=hunter2 was rejected'), '', 'must never echo request material');
});
