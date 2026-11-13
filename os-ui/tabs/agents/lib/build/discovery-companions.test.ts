/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISCOVERY_COMPANIONS, withDiscoveryCompanions } from '@tabs/agents/lib/build/os-tools';

/**
 * FEATURE:    The metric + dashboard discovery companions (C4).
 *
 * USER STORY: As a user asking "what was revenue last month" I want the assistant to be
 *             able to SEE which governed metric members exist, because being told to
 *             prefer `query_metric` is useless without `list_metrics`.
 *
 * ARCHITECTURE:
 *   `DISCOVERY_COMPANIONS` widens DISCOVERY, never authority: a companion is added only
 *   alongside a tool that was already granted, every companion is read-only, and the real
 *   call is still double-gated (system grant ∩ the user's own role/OPA/DLS). This test
 *   pins the two new entries and asserts the read-only property across the whole map, so a
 *   future entry cannot smuggle a write tool in as a "companion".
 */

test('C4: query_metric carries list_metrics, get_metric and get_dataset', () => {
  assert.deepEqual(DISCOVERY_COMPANIONS.query_metric, ['list_metrics', 'get_metric', 'get_dataset']);
});

test('C4: create_dashboard carries list_dashboards, list_metrics and get_dataset', () => {
  assert.deepEqual(DISCOVERY_COMPANIONS.create_dashboard, ['list_dashboards', 'list_metrics', 'get_dataset']);
});

test('C4: the companions are appended in order, deduped, after the tool that earned them', () => {
  const out = withDiscoveryCompanions(['query_metric']);
  assert.equal(out[0], 'query_metric', 'the granted tool stays first');
  assert.deepEqual(out, ['query_metric', 'list_metrics', 'get_metric', 'get_dataset']);
  // Two tools sharing a companion must not duplicate it.
  const both = withDiscoveryCompanions(['query_metric', 'create_dashboard']);
  assert.equal(new Set(both).size, both.length, 'companions must be deduped');
  assert.equal(both.filter((n) => n === 'get_dataset').length, 1);
});

test('C4: a companion is never added for a tool that was not granted', () => {
  assert.deepEqual(withDiscoveryCompanions(['whoami']), ['whoami']);
});

test('C4: every companion in the whole map is a READ tool — discovery widens, authority never does', () => {
  const writeish =
    /^(define|create|update|delete|promote|publish|commit|run|deploy|request|decide|set|archive|retire|ingest|transform|build|push|adopt|revoke|approve|apply|import|export|upload|configure|refresh|sync|start|advance|restore|propose|verify|classify|reconcile|use)_/;
  for (const [tool, companions] of Object.entries(DISCOVERY_COMPANIONS)) {
    for (const c of companions) {
      assert.ok(!writeish.test(c), `${tool} pulls in ${c}, which reads as a write tool`);
    }
  }
});
