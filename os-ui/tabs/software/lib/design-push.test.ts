/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppEpic } from './apps.ts';
import {
  planJiraIssues,
  pickConnectionForTemplate,
  validateFrontendImport,
} from './design-push.ts';

function epic(over: Partial<AppEpic>): AppEpic {
  return {
    id: 'e1',
    title: 'Epic one',
    description: 'desc',
    requirements: { technical: '', ux: '', governance: '' },
    stories: [],
    ...over,
  };
}

test('planJiraIssues maps each epic to an Epic then its stories to Story issues, in order', () => {
  const epics: AppEpic[] = [
    epic({
      id: 'e1',
      title: 'Overdue invoices',
      description: 'See what is late',
      stories: [
        { id: 's1', title: 'List overdue', asA: 'seller', iWant: 'a list', soThat: 'I chase them', acceptance: 'sorted by due date' },
      ],
    }),
  ];
  const plan = planJiraIssues(epics);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].issueType, 'Epic');
  assert.deepEqual(plan[0].ref, { epicId: 'e1' });
  assert.equal(plan[0].summary, 'Overdue invoices');
  assert.equal(plan[1].issueType, 'Story');
  assert.deepEqual(plan[1].ref, { epicId: 'e1', storyId: 's1' });
  assert.equal(plan[1].summary, 'List overdue');
  assert.match(plan[1].description, /As a seller, I want a list so that I chase them\./);
  assert.match(plan[1].description, /Acceptance: sorted by due date/);
});

test('planJiraIssues skips blank-title epics and falls back to epic title for blank stories', () => {
  const epics: AppEpic[] = [
    epic({ id: 'blank', title: '   ', stories: [{ id: 's', title: '', asA: '', iWant: '', soThat: '', acceptance: '' }] }),
    epic({ id: 'e2', title: 'Named', stories: [{ id: 's2', title: '', asA: '', iWant: '', soThat: '', acceptance: '' }] }),
  ];
  const plan = planJiraIssues(epics);
  // Only the named epic + its story (which borrows the epic title) survive.
  assert.equal(plan.length, 2);
  assert.equal(plan[0].summary, 'Named');
  assert.equal(plan[1].summary, 'Named');
});

test('pickConnectionForTemplate prefers a granted connection over other visible ones', () => {
  const visible = [
    { id: 'c-github-a', template: 'github' },
    { id: 'c-github-b', template: 'github' },
    { id: 'c-jira', template: 'atlassian' },
  ];
  assert.equal(pickConnectionForTemplate('github', ['c-github-b'], visible)?.id, 'c-github-b');
  // No grant → first visible of that template.
  assert.equal(pickConnectionForTemplate('github', [], visible)?.id, 'c-github-a');
  // None of that template → null (route surfaces "connect first").
  assert.equal(pickConnectionForTemplate('slack', ['c-github-b'], visible), null);
});

test('validateFrontendImport accepts React code and seeds src/App.tsx', () => {
  const r = validateFrontendImport('export default function App() { return <div>Hi</div>; }');
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0].path, 'src/App.tsx');
    assert.ok(r.files[0].content.endsWith('\n'));
  }
});

test('validateFrontendImport seeds src/index.html for a full HTML document', () => {
  const r = validateFrontendImport('<!doctype html><html><body><h1>Hi</h1></body></html>');
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.files[0].path, 'src/index.html');
});

test('validateFrontendImport rejects empty and non-frontend input honestly', () => {
  assert.equal(validateFrontendImport('   ').ok, false);
  assert.equal(validateFrontendImport('just some plain prose about invoices').ok, false);
});
