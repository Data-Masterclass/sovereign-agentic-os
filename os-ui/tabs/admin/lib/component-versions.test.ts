/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       admin
 * FEATURE:    Component versions on Platform are real or say "not reported"
 * USER STORY: As a platform admin I want the Version column to show the os-ui version this
 *             install really runs, and "not reported" for a component whose version nothing
 *             reads, so I never plan an upgrade from a number someone typed in once.
 * ARCHITECTURE:
 *   - os-ui's version is `config.osVersion` (the chart sets `OS_VERSION`).
 *   - No governed reader of the other components' image tags exists, so the hard-coded table
 *     is gone and every other component says "not reported".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '@core/kernel/config';
import { versionFor } from '@tabs/admin/lib/components-extra';

test('os-ui reports the version this install runs (config.osVersion), not a typed-in one', () => {
  assert.equal(versionFor('os-ui').replace(/^v/, ''), config.osVersion.replace(/^v/, ''));
});

test('a component whose version nothing reads says "not reported"', () => {
  for (const id of ['litellm', 'opensearch', 'trino', 'dagster', 'minio']) {
    assert.equal(versionFor(id), 'not reported', id);
  }
});
