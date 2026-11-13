/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SEMANTIC_LAYER_RULE,
  TRUNCATION_RULE,
  AD_HOC_RULE,
  ASK_RULES_BLOCK,
  ASK_GUIDE_SECTION,
  ASK_RULE_GUIDE_FILES,
} from '@core/runtime/ask-rules';
import { osAssistantSystem } from '@core/runtime/agent-loop';

/**
 * FEATURE:    Content tripwires for the semantic-layer-first, truncation and ad-hoc rules.
 *
 * USER STORY: As a maintainer I want the rule that keeps a chat answer grounded in the
 *             governed metric to be impossible to delete from one surface and leave in
 *             another, because a prompt and four guides that disagree is worse than none.
 *
 * ARCHITECTURE:
 *   `core/runtime/ask-rules.ts` is the one source; this test asserts the identical bytes
 *   reach the Ask-the-OS system prompt AND each of the four MCP guides an external client
 *   reads. The guide files are read from disk (markdown, not importable), so deleting the
 *   section fails here rather than silently at runtime.
 */

const UI = join(import.meta.dirname, '..', '..');

// (C2) the system prompt ------------------------------------------------------
test('C2: OS_RULES carries the semantic-layer-first rule verbatim', () => {
  const sys = osAssistantSystem('data');
  assert.ok(sys.includes(SEMANTIC_LAYER_RULE), 'the system prompt lost the semantic-layer rule');
  assert.ok(sys.includes('list_metrics'), 'the rule must name list_metrics');
  assert.ok(sys.includes('query_metric'), 'the rule must name query_metric');
});

test('C5/C6: OS_RULES forbids aggregating a truncated result and labels an ad-hoc answer', () => {
  const sys = osAssistantSystem(null);
  assert.ok(sys.includes(TRUNCATION_RULE), 'the system prompt lost the truncation rule');
  assert.ok(sys.includes(AD_HOC_RULE), 'the system prompt lost the ad-hoc label rule');
  assert.ok(/NEVER aggregate/.test(ASK_RULES_BLOCK));
});

test('C2: the rule is present whether or not a tab lens is in focus', () => {
  for (const tab of ['data', 'metrics', 'dashboards', null] as const) {
    assert.ok(osAssistantSystem(tab).includes(SEMANTIC_LAYER_RULE), `tab ${tab} lost the rule`);
  }
});

// (C3) the four guides --------------------------------------------------------
test('C3: all four MCP guides carry the identical semantic-layer section', () => {
  assert.equal(ASK_RULE_GUIDE_FILES.length, 4);
  for (const rel of ASK_RULE_GUIDE_FILES) {
    const text = readFileSync(join(UI, rel), 'utf8');
    assert.ok(text.includes(ASK_GUIDE_SECTION), `${rel} does not carry ASK_GUIDE_SECTION verbatim`);
    assert.ok(text.includes(TRUNCATION_RULE), `${rel} lost the truncation rule`);
  }
});

test('C3: the guides name the exact tools, so an external client can act on the rule', () => {
  for (const rel of ASK_RULE_GUIDE_FILES) {
    const text = readFileSync(join(UI, rel), 'utf8');
    for (const tool of ['list_metrics', 'query_metric', 'query_data']) {
      assert.ok(text.includes(tool), `${rel} does not name ${tool}`);
    }
  }
});
