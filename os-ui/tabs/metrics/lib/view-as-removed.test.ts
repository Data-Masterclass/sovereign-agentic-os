/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       metrics
 * FEATURE:    No "View as DE / FR / US" control on the metric explorer
 * USER STORY: As a KPI reader I want every control on the explorer to change what I see, so I
 *             never think I am looking at another region's numbers when I am looking at mine.
 * ARCHITECTURE:
 *   - The control sent `viewerRegion`, which `delegatedToken` ignores for every role but admin,
 *     and which only the offline stand-in rows ever read: on a live install it changed nothing.
 *     The control and the field it sent are removed; the route's admin-only parameter is left.
 *   - Reads the component as text (a test cannot import a `.tsx`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('the metric explorer has no "View as" control and sends no viewerRegion', () => {
  const src = readFileSync(join(process.cwd(), 'tabs/metrics/ui/ExploreMetric.tsx'), 'utf8');
  assert.doesNotMatch(src, /View as/);
  assert.doesNotMatch(src, /viewerRegion/);
  assert.doesNotMatch(src, /'DE', 'FR', 'US'/);
});
