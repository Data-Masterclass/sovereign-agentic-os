/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       workflows
 * FEATURE:    The Workflows module README says what the tab is: process documentation
 * USER STORY: As a contributor or operator reading the module README I want it to say that the
 *             Workflows tab documents processes and runs nothing, so I do not look here for
 *             governed runs or schedules that live in the Agents tab.
 * ARCHITECTURE:
 *   - The manifest is the contract: no APIs of its own, no policies, and ONE MCP tool bundle
 *     (`knowledge-write`: author/list/get/index/publish/retire a workflow). The page renders the
 *     workflow store's process documents. The README is checked against that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { manifest } from '@tabs/workflows/manifest';

test('the README claims no governed run or schedule, and says the tab runs nothing', () => {
  const readme = readFileSync(join(process.cwd(), 'tabs/workflows/README.md'), 'utf8');
  assert.equal(manifest.api.length, 0);
  assert.deepEqual(manifest.mcpTools, ['knowledge-write']);
  assert.doesNotMatch(readme, /one governed run|orchestrate agents/i);
  assert.match(readme, /runs nothing/i);
  // It owns its tools and says a workflow is not a knowledge note.
  assert.match(readme, /author_workflow/);
  assert.match(readme, /not\*\* a knowledge note/i);
});
