/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    One column-name rule for os-ui and the data-runner
 * USER STORY: As someone uploading a file I want os-ui and the ingest service to agree on which
 *             column names are fine — emoji, umlauts and spaces included — so an upload is never
 *             accepted by one side and refused by the other.
 * ARCHITECTURE:
 *   - `images/extensions/data-runner/column_name_rule.json` is the one definition (the runner
 *     loads it). `literal.COLUMN_NAME_RULE` must equal it, and both implementations run the shared
 *     `column_name_cases.json` (the runner's half is `test_bronze_raw.py SharedColumnRuleTest`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLUMN_NAME_RULE, isColumnName, normalizeColumnName } from '@tabs/data/lib/dbt/literal';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'images', 'extensions', 'data-runner');
const rule = JSON.parse(readFileSync(join(RUNNER, 'column_name_rule.json'), 'utf8'));
const cases = JSON.parse(readFileSync(join(RUNNER, 'column_name_cases.json'), 'utf8')) as { accept: string[]; refuse: string[] };

test('os-ui holds exactly the data-runner\'s column-name rule', () => {
  assert.deepEqual(
    { maxCodePoints: COLUMN_NAME_RULE.maxCodePoints, forbidden: COLUMN_NAME_RULE.forbidden, edgeForbidden: COLUMN_NAME_RULE.edgeForbidden },
    { maxCodePoints: rule.maxCodePoints, forbidden: rule.forbidden, edgeForbidden: rule.edgeForbidden },
  );
});

test('the shared cases: BOM, code-point length and emoji decided exactly as the runner decides', () => {
  for (const n of cases.accept) assert.equal(isColumnName(n), true, JSON.stringify(n));
  for (const n of cases.refuse) assert.equal(isColumnName(n), false, JSON.stringify(n));
  assert.equal(isColumnName('\u{1F4E6}'.repeat(128)), true, '128 emoji = 128 code points = 256 UTF-16 units: accepted');
});

test('every normalised upload name satisfies the rule', () => {
  for (const n of [...cases.accept, ...cases.refuse]) assert.equal(isColumnName(normalizeColumnName(n)), true, JSON.stringify(n));
});
