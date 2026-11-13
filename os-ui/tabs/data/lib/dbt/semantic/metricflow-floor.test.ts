/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The MetricFlow licence floor is enforced, and the licence gate still calls it
 * USER STORY: As a maintainer I want `metricflow <= 0.208.1` to be impossible to add: those
 *             releases are Business Source License 1.1, whose Additional Use Grant excludes this
 *             product's use, and BSL does not relax retroactively (checklist M14).
 * ARCHITECTURE:
 *   - Imports the ONE implementation `scripts/license-check.sh` runs, so the suite and the gate
 *     cannot disagree, and asserts the gate still invokes it (a check that is silently dropped from
 *     the gate is worse than no check).
 *   - Also asserts the repo is clean TODAY, so adding a bad pin fails here as well as in CI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  METRICFLOW_FLOOR,
  FLOOR_ROOTS,
  checkMetricflowFloor,
  collectEntries,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — a repo-tooling .mjs with no type declarations; the shapes are asserted below.
} from '../../../../../../scripts/metricflow-floor.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..');

type Violation = { path: string; spec: string; reason: string };
const check = checkMetricflowFloor as (entries: { path: string; text: string }[]) => Violation[];

test('M14: the floor is the first Apache-2.0 release', () => {
  assert.equal(METRICFLOW_FLOOR, '0.209.0');
});

test('M14: a BSL-era pin is DENIED with the licence reason, not just a version complaint', () => {
  const bad = check([{ path: 'images/x/Dockerfile', text: 'RUN pip install "metricflow==0.208.1"' }]);
  assert.equal(bad.length, 1);
  assert.match(bad[0].reason, /Business Source License 1\.1/);
  assert.match(bad[0].reason, /does not relax retroactively/);
});

test('M14: every way of letting a BSL release in is denied — unpinned, upper-bound-only, too-low floor', () => {
  const cases = [
    'RUN pip install metricflow',
    'RUN pip install "metricflow<0.300"',
    'RUN pip install "metricflow>=0.200,<0.300"',
    'metricflow~=0.208.0',
    'dbt-metricflow[dbt-duckdb]==0.207.0',
    'RUN pip install "metricflow>0.209.0rc1"',
  ];
  for (const text of cases) {
    const v = check([{ path: 'images/x/Dockerfile', text }]);
    assert.ok(v.length >= 1, `should be denied: ${text}`);
  }
});

test('M14: a correct pin passes, in every spelling the images use', () => {
  const ok = [
    'RUN pip install "metricflow>=0.209.0"',
    'RUN pip install "metricflow >= 0.209.0"',
    'RUN pip install "metricflow>=0.209.0,<0.300"',
    'dbt-metricflow[dbt-trino]>=0.210.1',
    'metricflow==0.209.0',
    // The extras bracket must not break the match.
    'dbt-metricflow[dbt-duckdb]>=0.209.0',
  ];
  for (const text of ok) {
    assert.deepEqual(check([{ path: 'images/x/Dockerfile', text }]), [], text);
  }
});

test('M14: absence passes — MetricFlow is not installed anywhere today, and that is a pass not a skip', () => {
  assert.deepEqual(check([{ path: 'images/x/Dockerfile', text: 'RUN pip install "dbt-core>=1.8,<1.10" "dbt-trino>=1.8,<1.10"' }]), []);
});

test('M14: the repository is clean right now', () => {
  const entries = (collectEntries as (roots: string[], base: string) => { path: string; text: string }[])(FLOOR_ROOTS as string[], REPO);
  assert.ok(entries.length > 0, 'the scan found no files at all — the roots are wrong');
  assert.deepEqual(check(entries), []);
});

test('M14: the licence gate still invokes the floor check (a dropped check is worse than none)', () => {
  const gate = readFileSync(join(REPO, 'scripts', 'license-check.sh'), 'utf8');
  assert.match(gate, /scripts\/metricflow-floor\.mjs/);
  assert.match(gate, /fail=1/);
});
