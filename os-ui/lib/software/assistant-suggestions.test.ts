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
  applyEpicRequirementsSuggestion,
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

test('a suggested story carries its drafted spec (features/nfrs/rules) into the materialised AppStory', () => {
  const next = applyStoriesSuggestion(
    [{ id: 'e1', title: 'Reminders', description: '', requirements: { technical: '', ux: '', governance: '' }, stories: [] }],
    [{ epicTitle: 'Reminders', stories: [{ title: 'Send reminder', spec: { features: ['Send an email'], nfrs: [' '], rules: ['Held for approval'] } }] }],
  );
  const story = next[0].stories[0];
  assert.deepEqual(story.spec?.features, ['Send an email']);
  assert.deepEqual(story.spec?.rules, ['Held for approval']);
  assert.equal(story.spec?.nfrs?.length ?? 0, 0, 'blank nfr dropped by normalizeSpec');
});

test('applyEpicRequirementsSuggestion fills only EMPTY requirement fields on the matching epic', () => {
  const epics: AppEpic[] = [
    { id: 'e1', title: 'Reminders', description: '', requirements: { technical: 'existing', ux: '', governance: '' }, stories: [] },
    { id: 'e2', title: 'Other', description: '', requirements: { technical: '', ux: '', governance: '' }, stories: [] },
  ];
  const next = applyEpicRequirementsSuggestion(epics, [
    { epicTitle: 'reminders', requirements: { technical: 'new tech (ignored)', ux: 'one-click', governance: 'approval' } },
    { epicTitle: 'Nonexistent', requirements: { ux: 'orphan' } },
  ]);
  assert.equal(next[0].requirements.technical, 'existing', 'non-empty field never overwritten');
  assert.equal(next[0].requirements.ux, 'one-click', 'empty field filled');
  assert.equal(next[0].requirements.governance, 'approval');
  assert.equal(next[1].requirements.ux, '', 'unmatched epic untouched');
});

test('normalizeAssistantReply surfaces story-level specs + epic requirements', () => {
  const reply = normalizeAssistantReply(
    {
      message: 'Next steps.',
      suggestedStories: [
        { epicTitle: 'Reminders', stories: [{ title: 'Escalate', spec: { features: ['Ping the manager'] } }] },
      ],
      suggestedEpicRequirements: [
        { epicTitle: 'Reminders', requirements: { technical: 'cron', ux: '  ' } },
        { epicTitle: 'x', requirements: {} }, // dropped: no requirement fields
      ],
    },
    KINDS as unknown as (typeof KINDS)[number][],
  );
  assert.deepEqual(reply.suggestions.suggestedStories?.[0].stories[0].spec?.features, ['Ping the manager']);
  assert.equal(reply.suggestions.suggestedEpicRequirements?.length, 1, 'empty-requirements group dropped');
  assert.equal(reply.suggestions.suggestedEpicRequirements?.[0].requirements.technical, 'cron');
  assert.equal(reply.suggestions.suggestedEpicRequirements?.[0].requirements.ux, undefined, 'blank field dropped');
});

test('0.6.101: normalizeAssistantReply surfaces suggestedDatasets, dropping the malformed', () => {
  const reply = normalizeAssistantReply(
    {
      message: 'Here is the data plan.',
      suggestedDatasets: [
        { name: 'employees', purpose: 'staff directory', columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'string' }], fill: 'dummy', rows: 10 },
        { name: 'no columns', columns: [], fill: 'empty' }, // dropped — a real column list is required
      ],
    },
    KINDS as unknown as (typeof KINDS)[number][],
  );
  assert.equal(reply.suggestions.suggestedDatasets?.length, 1, 'malformed (no columns) dropped');
  assert.equal(reply.suggestions.suggestedDatasets?.[0].name, 'employees');
  assert.equal(reply.suggestions.suggestedDatasets?.[0].fill, 'dummy');
  assert.equal(reply.suggestions.suggestedDatasets?.[0].rows, 10);
  assert.deepEqual(reply.suggestions.suggestedDatasets?.[0].columns.map((c) => c.name), ['id', 'name']);
});

test('0.6.93: a full-tree suggested epic (2 stories with specs + epic requirements) applies as ONE governed create', () => {
  // Item 2: proposing/creating an epic must carry its requirements AND each story's spec
  // (features/nfrs/rules) through the single apply, not just the titles.
  const applied = applyEpicsSuggestion([], [
    {
      title: 'Reminders',
      description: 'Chase overdue invoices',
      requirements: { technical: 'daily cron', ux: 'one-click snooze', governance: 'opted-in only' },
      stories: [
        {
          title: 'Send a due-date reminder',
          asA: 'user', iWant: 'an email before due', soThat: 'I do not miss it', acceptance: 'arrives 24h before',
          spec: { features: ['Compose email', 'Schedule 24h before'], nfrs: ['Sends within 1 min'], rules: ['Only opted-in'] },
        },
        {
          title: 'Snooze a reminder',
          asA: 'user', iWant: 'to defer it', soThat: 'I act later', acceptance: 'snooze persists',
          spec: { features: ['Snooze 1 day'], nfrs: [], rules: ['Max 3 snoozes'] },
        },
      ],
    },
  ]);

  assert.equal(applied.length, 1);
  const epic = applied[0];
  // Epic requirements rode along, not dropped to a later step.
  assert.equal(epic.requirements.technical, 'daily cron');
  assert.equal(epic.requirements.ux, 'one-click snooze');
  assert.equal(epic.requirements.governance, 'opted-in only');
  // Both stories materialised WITH their specs.
  assert.equal(epic.stories.length, 2);
  assert.deepEqual(epic.stories[0].spec?.features, ['Compose email', 'Schedule 24h before']);
  assert.deepEqual(epic.stories[0].spec?.nfrs, ['Sends within 1 min']);
  assert.deepEqual(epic.stories[0].spec?.rules, ['Only opted-in']);
  assert.deepEqual(epic.stories[1].spec?.features, ['Snooze 1 day']);
  assert.deepEqual(epic.stories[1].spec?.rules, ['Max 3 snoozes']);
});

test('0.6.93: a full-tree epic round-trips model-JSON → normalize → apply with specs + requirements intact', () => {
  // The normalizers must not drop specs/requirements when parsing an epic suggestion.
  const reply = normalizeAssistantReply(
    {
      message: 'Here is the whole branch.',
      suggestedEpics: [
        {
          title: 'Reminders',
          description: 'Chase invoices',
          requirements: { technical: 'cron', ux: 'snooze', governance: 'opted-in' },
          stories: [
            { title: 'Send reminder', spec: { features: ['Send email'], nfrs: ['<1min'], rules: ['Opted-in'] } },
            { title: 'Snooze', spec: { features: ['Snooze a day'] } },
          ],
        },
      ],
    },
    KINDS as unknown as (typeof KINDS)[number][],
  );

  const epics = reply.suggestions.suggestedEpics ?? [];
  assert.equal(epics.length, 1, 'epic survived normalisation');
  assert.equal(epics[0].requirements?.technical, 'cron', 'requirements survived normalisation');
  assert.equal(epics[0].stories?.length, 2);
  assert.deepEqual(epics[0].stories?.[0].spec?.features, ['Send email'], 'story spec survived normalisation');

  // …and applying that normalised epic persists the whole tree.
  const applied = applyEpicsSuggestion([], epics);
  assert.equal(applied[0].requirements.governance, 'opted-in');
  assert.deepEqual(applied[0].stories[0].spec?.rules, ['Opted-in']);
  assert.deepEqual(applied[0].stories[1].spec?.features, ['Snooze a day']);
});
