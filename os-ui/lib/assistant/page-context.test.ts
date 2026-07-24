/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePageContext, renderPageContext } from './page-context.ts';
import { osAssistantSystem } from './agent-loop.ts';

// (sanitize) ------------------------------------------------------------------
test('sanitizePageContext keeps usable string fields and caps extra', () => {
  const ctx = sanitizePageContext({
    tab: 'data',
    stage: 'silver',
    artifactType: 'dataset',
    artifactId: 'ds-123',
    artifactName: 'Orders',
    extra: { rows: '10k', junk: 42 },
  });
  assert.deepEqual(ctx, {
    tab: 'data',
    stage: 'silver',
    artifactType: 'dataset',
    artifactId: 'ds-123',
    artifactName: 'Orders',
    extra: { rows: '10k' }, // non-string extra value dropped
  });
});

test('sanitizePageContext returns null for empty / malformed input (defensive)', () => {
  assert.equal(sanitizePageContext(null), null);
  assert.equal(sanitizePageContext(undefined), null);
  assert.equal(sanitizePageContext('nope'), null);
  assert.equal(sanitizePageContext({}), null);
  assert.equal(sanitizePageContext({ tab: 42, artifactId: {} }), null);
});

// (render) --------------------------------------------------------------------
test('renderPageContext returns empty string when there is nothing to say', () => {
  assert.equal(renderPageContext(null), '');
  assert.equal(renderPageContext(undefined), '');
});

test('renderPageContext names the open artifact and instructs it as the default subject', () => {
  const block = renderPageContext({
    tab: 'data',
    stage: 'silver',
    artifactType: 'dataset',
    artifactId: 'ds-123',
    artifactName: 'Orders',
  });
  assert.match(block, /Tab: data/);
  assert.match(block, /Stage \/ step: silver/);
  assert.match(block, /Open dataset: "Orders" \[id: ds-123\]/);
  assert.match(block, /DEFAULT SUBJECT/);
  assert.match(block, /do NOT ask for its\s*\n?\s*id/i);
});

test('renderPageContext without an artifact omits the default-subject directive', () => {
  const block = renderPageContext({ tab: 'agents', stage: 'design' });
  assert.match(block, /Tab: agents/);
  assert.doesNotMatch(block, /DEFAULT SUBJECT/); // no open artifact → no directive
});

// (fold into the assistant request) -------------------------------------------
test('osAssistantSystem folds the open-dataset context into the system prompt', () => {
  const page = sanitizePageContext({
    tab: 'data',
    stage: 'silver',
    artifactType: 'dataset',
    artifactId: 'ds-123',
    artifactName: 'Orders',
  });
  const sys = osAssistantSystem('data', page);
  // The assembled request references dataset X, so the model needn't ask for its id.
  assert.match(sys, /ds-123/);
  assert.match(sys, /Orders/);
  assert.match(sys, /DEFAULT SUBJECT/);
});

test('osAssistantSystem is unchanged when no page context is published (enrich-only)', () => {
  const withNothing = osAssistantSystem('data', null);
  const legacy = osAssistantSystem('data'); // omitted arg == today's call site
  assert.equal(withNothing, legacy);
  assert.doesNotMatch(withNothing, /WHERE THE USER IS RIGHT NOW/);
});
