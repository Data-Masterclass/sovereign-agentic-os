/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore, createWorkflow, getWorkflow } from './store.ts';
import { findGaps } from './gaps.ts';
import { resolveEntityIndex } from './mock-entities.ts';

/**
 * Contract test for the Knowledge workflow-detail render (components/knowledge/
 * WorkflowView.tsx). The view accesses several fields UNCONDITIONALLY:
 *   data.gaps.length, data.visibility, data.domain, data.archived,
 *   data.workflow.steps — and findGaps() walks workflow.steps/step.links.
 * A bare, freshly-created workflow (the re-seeded shape: no steps, no rules,
 * frontmatter only) must still produce a complete, render-safe payload so the
 * detail view never throws a client-side render exception.
 */

const builder = { id: 'bea', domains: ['sales'], role: 'builder' as const };

/** Rebuild exactly what GET /api/knowledge/workflows/[id] returns to the client. */
async function detailPayload(id: string, user: typeof builder) {
  const view = getWorkflow(id, user);
  const index = await resolveEntityIndex(view.domain);
  const gaps = findGaps(view.workflow, index);
  return { ...view, gaps };
}

test('a bare workflow yields a complete, render-safe detail payload', async () => {
  __resetStore();
  const rec = createWorkflow(builder, { title: 'Campaign Optimizer', domain: 'sales' });
  const data = await detailPayload(rec.id, builder);

  // Every field the detail view reads unconditionally must be present + typed.
  assert.equal(typeof data.title, 'string');
  assert.equal(typeof data.domain, 'string');
  assert.ok(['Personal', 'Shared', 'Marketplace'].includes(data.visibility));
  assert.ok(['draft', 'live'].includes(data.status));
  assert.ok(Array.isArray(data.gaps), 'gaps must always be an array');
  assert.ok(data.workflow, 'workflow must be present');
  assert.ok(Array.isArray(data.workflow.steps), 'workflow.steps must be an array');
  assert.ok(Array.isArray(data.workflow.rules), 'workflow.rules must be an array');
  // `archived` is optional in the shape; the view coerces with !! — undefined is fine.
  assert.ok(data.archived === undefined || typeof data.archived === 'boolean');
});

test('gaps + steps are safe to read on a workflow with no steps', async () => {
  __resetStore();
  const rec = createWorkflow(builder, { title: 'Empty Flow', domain: 'sales' });
  const data = await detailPayload(rec.id, builder);
  // The two hottest unconditional accesses in the render:
  assert.equal(data.gaps.length, 0);
  assert.equal(data.workflow.steps.length, 0);
});
