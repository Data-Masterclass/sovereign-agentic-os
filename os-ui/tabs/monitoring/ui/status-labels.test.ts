/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Monitoring status words keep their English and exist in every language
 * USER STORY: As an English operator I want a badge to read exactly as before ("fail", "not run",
 *             "requires_approval"); as a Polish operator I want every one of them in Polish.
 * ARCHITECTURE: Pure — renders `monitoring.status.<key>` through the catalogs with the shared test helper.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_KEYS, statusKey } from '@tabs/monitoring/ui/status-labels';
import { catalogText, hasCatalogKey, CATALOG_LOCALES } from '@core/testing/catalog-text';

test('every raw status word renders, in English, exactly as the UI printed it before', () => {
  for (const [raw, key] of Object.entries(STATUS_KEYS)) {
    const expected = raw === 'not_run' ? 'not run' : raw; // the UI already printed not_run as "not run"
    assert.equal(catalogText('monitoring', { key: `status.${key}` }), expected, raw);
  }
});

test('every status key exists, non-empty, in all seven locales', () => {
  for (const key of Object.values(STATUS_KEYS)) {
    for (const loc of CATALOG_LOCALES) {
      assert.ok(hasCatalogKey('monitoring', `status.${key}`, loc), `${loc}: status.${key}`);
      assert.notEqual(catalogText('monitoring', { key: `status.${key}` }, loc).trim(), '', `${loc}: status.${key} empty`);
    }
  }
});

test('statusKey: known words map, unknown and upper-case words stay verbatim (null)', () => {
  assert.equal(statusKey('not_run'), 'notRun');
  assert.equal(statusKey('requires_approval'), 'requiresApproval');
  assert.equal(statusKey('failure'), 'failure');
  assert.equal(statusKey('FAILURE'), null);
  assert.equal(statusKey('something_new'), null);
  assert.equal(statusKey(undefined), null);
  assert.equal(statusKey('toString'), null);
});
