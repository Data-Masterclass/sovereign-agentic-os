/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextAccessCap, emptyContextGrants, accessOf, isGranted } from '../core/context-grants.ts';
import type { AppEpic } from './apps.ts';
import {
  applyPurposeSuggestion,
  applyGrantsSuggestion,
  applyEpicsSuggestion,
  applyStoriesSuggestion,
  normalizeAssistantReply,
} from './assistant-suggestions.ts';

const KINDS = ['connections', 'data', 'knowledge', 'files', 'metrics'] as const;

test('applyPurposeSuggestion trims the proposed purpose', () => {
  assert.equal(applyPurposeSuggestion('  Track overdue invoices.  '), 'Track overdue invoices.');
});

test('applyGrantsSuggestion folds new grants in, clamped to the cap, without removing existing', () => {
  const cap = contextAccessCap('read-propose'); // ceiling read+propose
  let grants = emptyContextGrants();
  grants = { ...grants, data: [{ id: 'ds_keep', access: 'read-only' }] };

  const next = applyGrantsSuggestion(
    grants,
    [
      { kind: 'data', id: 'ds_new', access: 'read-write' }, // above ceiling → clamps to read-propose
      { kind: 'connections', id: 'conn_1' }, // no access → cap default (read-propose)
      { kind: 'bogus' as never, id: 'x' }, // unknown kind → ignored
      { kind: 'files', id: '' }, // empty id → ignored
    ],
    cap,
  );

  assert.equal(isGranted(next, 'data', 'ds_keep'), true, 'existing grant preserved');
  assert.equal(accessOf(next, 'data', 'ds_new'), 'read-propose', 'clamped down to ceiling');
  assert.equal(accessOf(next, 'connections', 'conn_1'), 'read-propose', 'defaults to cap default');
  assert.equal(isGranted(next, 'files', ''), false);
  // Purity: original untouched.
  assert.equal(isGranted(grants, 'data', 'ds_new'), false);
});

test('applyGrantsSuggestion respects a locked (read-only) cap', () => {
  const cap = contextAccessCap('read-only');
  const next = applyGrantsSuggestion(emptyContextGrants(), [{ kind: 'data', id: 'ds', access: 'read-write' }], cap);
  assert.equal(accessOf(next, 'data', 'ds'), 'read-only');
});

test('applyEpicsSuggestion appends materialised epics with ids + stories, dropping empty titles', () => {
  const existing: AppEpic[] = [
    { id: 'epic_a', title: 'Existing', description: '', requirements: { technical: '', ux: '', governance: '' }, stories: [] },
  ];
  const next = applyEpicsSuggestion(existing, [
    {
      title: 'Reminders',
      description: 'Chase overdue invoices',
      requirements: { technical: 'cron', ux: 'one-click' },
      stories: [{ title: 'Send reminder', asA: 'clerk', iWant: 'to remind', soThat: 'we get paid', acceptance: 'email sent' }],
    },
    { title: '   ' }, // dropped
  ]);

  assert.equal(next.length, 2);
  assert.equal(next[0].id, 'epic_a', 'existing epic kept in place');
  const created = next[1];
  assert.equal(created.title, 'Reminders');
  assert.equal(created.requirements.governance, '', 'missing requirement defaults to empty string');
  assert.ok(created.id.startsWith('epic_'));
  assert.equal(created.stories.length, 1);
  assert.ok(created.stories[0].id.startsWith('story_'));
  assert.equal(created.stories[0].asA, 'clerk');
});

test('applyStoriesSuggestion adds stories to the matching epic (case-insensitive), dropping non-matches', () => {
  const epics: AppEpic[] = [
    { id: 'e1', title: 'Reminders', description: '', requirements: { technical: '', ux: '', governance: '' }, stories: [] },
  ];
  const next = applyStoriesSuggestion(epics, [
    { epicTitle: 'reminders', stories: [{ title: 'Escalate', acceptance: 'manager pinged' }, { title: '' }] },
    { epicTitle: 'Nonexistent', stories: [{ title: 'orphan' }] },
  ]);

  assert.equal(next[0].stories.length, 1, 'only the valid story added; empty-title dropped');
  assert.equal(next[0].stories[0].title, 'Escalate');
  assert.equal(next.length, 1, 'no new epic created for the unmatched group');
});

test('normalizeAssistantReply guards shapes and only surfaces valid suggestions', () => {
  const reply = normalizeAssistantReply(
    {
      message: '  Here is a plan.  ',
      improvedPurpose: 'A crisper purpose.',
      suggestedGrants: [
        { kind: 'data', id: 'ds_1', access: 'read-write', reason: 'source of invoices' },
        { kind: 'nope', id: 'x' },
        { id: 'missing-kind' },
      ],
      suggestedEpics: [{ title: 'Epic 1', stories: [{ title: 'S1' }, { notATitle: true }] }, { description: 'no title' }],
      suggestedStories: [{ epicTitle: 'Epic 1', stories: [{ title: 'S2' }] }, { epicTitle: 'x', stories: [] }],
    },
    KINDS as unknown as (typeof KINDS)[number][],
  );

  assert.equal(reply.message, 'Here is a plan.');
  assert.equal(reply.suggestions.improvedPurpose, 'A crisper purpose.');
  assert.equal(reply.suggestions.suggestedGrants?.length, 1);
  assert.equal(reply.suggestions.suggestedGrants?.[0].id, 'ds_1');
  assert.equal(reply.suggestions.suggestedEpics?.length, 1);
  assert.equal(reply.suggestions.suggestedEpics?.[0].stories?.length, 1, 'invalid story dropped');
  assert.equal(reply.suggestions.suggestedStories?.length, 1, 'empty-story group dropped');
});

test('normalizeAssistantReply on junk yields an empty, safe reply', () => {
  const reply = normalizeAssistantReply(null, KINDS as unknown as (typeof KINDS)[number][]);
  assert.equal(reply.message, '');
  assert.deepEqual(reply.suggestions, {});
});
