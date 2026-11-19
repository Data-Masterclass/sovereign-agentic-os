/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       software
 * FEATURE:    `use_as_data` describes what it does: it marks the app, it writes no dataset
 * USER STORY: As an assistant calling `use_as_data` I want its description to match its effect,
 *             so I do not tell the user a Bronze dataset now exists and send them to
 *             `list_datasets` for rows that were never written.
 * ARCHITECTURE:
 *   - `useAsData` (lifecycle.ts) sets `usedAsData` on the app and persists it; it calls no
 *     ingest and creates no dataset version. The test drives it for real and reads the tool
 *     description from `PLATFORM_MCP_TOOLS`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { createApp } from '@tabs/software/lib/apps';
import { useAsData } from '@tabs/software/lib/lifecycle';
import { PLATFORM_MCP_TOOLS } from '@tabs/software/lib/platform-mcp';

const owner: CurrentUser = { id: 'alice', name: 'Alice', domains: ['sales'], role: 'creator' };

test('use_as_data only sets the flag on the app', async () => {
  const app = await createApp(owner, { name: 'Use As Data', kind: 'spec' } as Parameters<typeof createApp>[1]);
  const before = { ...app, deploy: { ...app.deploy } };
  const after = await useAsData(app.id, owner);
  assert.equal(after.usedAsData, true);
  assert.equal(after.dataArtifactId, before.dataArtifactId, 'no new dataset is created');
});

test('its description promises no Bronze snapshot and no dataset version', () => {
  const tool = PLATFORM_MCP_TOOLS.find((t) => t.name === 'use_as_data');
  assert.ok(tool);
  assert.doesNotMatch(tool.description, /snapshot the app.s own records into a BRONZE dataset/i);
  assert.doesNotMatch(tool.description, /creates or adds a version to the dataset/i);
  assert.match(tool.description, /no rows are copied/i);
});
