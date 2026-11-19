/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The page-header cluster pill reflects the real stack status
 * USER STORY: As a user I want the header to say "Live cluster" only when the platform services
 *             really answer, and to say how many are up otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clusterPillState } from './cluster-pill.ts';

test('the header pill is not a hardcoded "Live cluster": it renders the status-driven pill', () => {
  const src = readFileSync(new URL('./PageHeader.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, />\s*Live cluster\s*</, 'no literal "Live cluster" in the header markup');
  assert.match(src, /<ClusterPill \/>/);
  const pill = readFileSync(new URL('./ClusterPill.tsx', import.meta.url), 'utf8');
  assert.match(pill, /fetch\('\/api\/status'/, 'the pill reads the stack status the app already serves');
});

test('"Live cluster" only when every probed service answered', () => {
  assert.equal(clusterPillState({ up: 8, total: 8 }).label, 'Live cluster');
  assert.equal(clusterPillState({ up: 8, total: 8 }).tone, 'up');
  const some = clusterPillState({ up: 5, total: 8 });
  assert.equal(some.label, '5/8 services up');
  assert.equal(some.tone, 'down');
  assert.equal(clusterPillState({ up: 0, total: 8 }).label, '0/8 services up');
});

test('no status, a failed read or nothing probed is never "Live cluster"', () => {
  assert.notEqual(clusterPillState(null).label, 'Live cluster');
  assert.equal(clusterPillState(null, true).label, 'Cluster status unknown');
  assert.equal(clusterPillState({ up: 0, total: 0 }).label, 'Cluster status unknown');
  assert.equal(clusterPillState({ up: 3, total: 3 }, true).tone, 'unknown');
});
