/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder A - story and epic files: parser fixtures, issues with line and fix, round trip
 * USER STORY: As a developer I want the story format to be strict and predictable: what the OS writes reads back
 *             exactly, and a malformed file is named with its line and the fix.
 * ARCHITECTURE: Pure tests over files.ts: the spec section 3.1 example verbatim, render(parse(x)) = x for canonical
 *             files, parse(render(doc)) = doc for generated docs, every refusal path, path classification incl.
 *             traversal attempts, and the living-spec assembly with duplicate ids.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StoryDoc, EpicDoc } from '@tabs/software/lib/app-builder-contracts';
import {
  classifyStoryPath,
  epicPath,
  parseEpicFile,
  parseLivingSpec,
  parseStoryFile,
  renderEpicFile,
  renderStoryFile,
  slugOf,
  storyPath,
  validateEpicDoc,
  validateStoryDoc,
  SPEC_LIMITS,
} from './files.ts';

const SPEC_EXAMPLE = `---
id: US-3
epic: EP-1
title: Submit an order
state: agreed          # draft | agreed — the only human-decided part of status
---
As a **sales rep** I want **to submit an order** so that **the warehouse can ship it**.

## Acceptance criteria

### AC-1 Valid order is accepted
- Given a signed-in sales rep
- When they submit an order with a customer and at least one line
- Then the order is saved with status "new"

### AC-2 Empty order is refused
- Given a signed-in sales rep
- When they submit an order with no lines
- Then they see "Add at least one line" and nothing is saved

## Notes
Free text, never parsed.
`;

const P = 'stories/EP-1-order-intake/US-3-submit-order.md';

test('the spec 3.1 example parses into the contract shape (comment in front matter ignored)', () => {
  const r = parseStoryFile(P, SPEC_EXAMPLE);
  assert.ok('story' in r, JSON.stringify(r));
  const s = r.story;
  assert.equal(s.id, 'US-3');
  assert.equal(s.epic, 'EP-1');
  assert.equal(s.state, 'agreed');
  assert.equal(s.asA, 'sales rep');
  assert.equal(s.iWant, 'to submit an order');
  assert.equal(s.soThat, 'the warehouse can ship it');
  assert.equal(s.criteria.length, 2);
  assert.deepEqual(s.criteria[1], {
    id: 'AC-2',
    title: 'Empty order is refused',
    given: ['a signed-in sales rep'],
    when: ['they submit an order with no lines'],
    then: ['they see "Add at least one line" and nothing is saved'],
  });
  assert.equal(s.notes, 'Free text, never parsed.');
  assert.equal(s.path, P);
});

test('render(parse(x)) = x for a canonical story (the renderer output is the canonical form)', () => {
  const r = parseStoryFile(P, SPEC_EXAMPLE);
  assert.ok('story' in r);
  const canonical = renderStoryFile(r.story);
  const again = parseStoryFile(P, canonical);
  assert.ok('story' in again);
  assert.equal(renderStoryFile(again.story), canonical);
  assert.deepEqual(again.story, r.story);
  // The only difference to the hand-written example is the dropped front-matter comment.
  assert.equal(canonical, SPEC_EXAMPLE.replace('agreed          # draft | agreed — the only human-decided part of status', 'agreed'));
});

test('And continues the previous keyword; render writes the first line of each keyword and And after it', () => {
  const text = `---\nid: US-1\nepic: EP-1\ntitle: x\nstate: draft\n---\n## Acceptance criteria\n\n### AC-1 t\n- Given a\n- And b\n- When c\n- Then d\n- And e\n`;
  const r = parseStoryFile('stories/EP-1/US-1.md', text);
  assert.ok('story' in r, JSON.stringify(r));
  assert.deepEqual(r.story.criteria[0].given, ['a', 'b']);
  assert.deepEqual(r.story.criteria[0].then, ['d', 'e']);
  assert.equal(renderStoryFile(r.story), text);
});

function gen(seed: number): Omit<StoryDoc, 'path'> {
  const pick = <T,>(xs: T[]) => xs[(seed = (seed * 1103515245 + 12345) % 2147483648) % xs.length];
  const words = ['order', 'Ünïcode café', 'a: colon', '#hash', '"quoted"', "it's", 'x'.repeat(30), '- dash', 'emoji 🚀', 'trailing'];
  const n = (seed % 4) + 0;
  return {
    id: `US-${(seed % 900) + 1}` as StoryDoc['id'],
    epic: `EP-${(seed % 9) + 1}` as StoryDoc['epic'],
    title: pick(words),
    asA: seed % 3 === 0 ? '' : pick(words),
    iWant: seed % 3 === 0 ? '' : pick(words),
    soThat: seed % 3 === 0 ? '' : pick(words),
    state: seed % 2 ? 'agreed' : 'draft',
    criteria: Array.from({ length: n }, (_, i) => ({
      id: `AC-${i + 1}` as StoryDoc['criteria'][number]['id'],
      title: i % 2 ? '' : pick(words),
      given: [pick(words)],
      when: [pick(words), pick(words)].slice(0, (i % 2) + 1),
      then: [pick(words)],
    })),
    notes: seed % 2 ? '' : `Line one\n\n## Not a section here\n- free bullet\n${pick(words)}`,
  };
}

test('parse(render(doc)) = doc for generated docs that pass validateStoryDoc (quoting, unicode, empty parts)', () => {
  for (let seed = 1; seed < 120; seed++) {
    const doc = gen(seed);
    assert.deepEqual(validateStoryDoc(doc), [], `seed ${seed}`);
    const path = `stories/${doc.epic}-x/${doc.id}-y.md`;
    const r = parseStoryFile(path, renderStoryFile(doc));
    assert.ok('story' in r, `seed ${seed}: ${JSON.stringify(r)}`);
    assert.deepEqual(r.story, { ...doc, path }, `seed ${seed}`);
  }
});

test('an epic round-trips; empty description and requirements included', () => {
  const e: Omit<EpicDoc, 'path'> = { id: 'EP-2', title: 'Order intake', description: 'Take orders.\n\nFrom reps.', requirements: { technical: 'Postgres', ux: '', governance: 'No PII\n- in logs' } };
  assert.deepEqual(validateEpicDoc(e), []);
  const text = renderEpicFile(e);
  const r = parseEpicFile('stories/EP-2-order-intake/_epic.md', text);
  assert.ok('epic' in r, JSON.stringify(r));
  assert.deepEqual(r.epic, { ...e, path: 'stories/EP-2-order-intake/_epic.md' });
  assert.equal(renderEpicFile(r.epic), text);
  const empty = renderEpicFile({ id: 'EP-3', title: 't', description: '', requirements: { technical: '', ux: '', governance: '' } });
  assert.equal(empty, '---\nid: EP-3\ntitle: t\n---\n## Requirements\n\n### Technical\n\n### UX\n\n### Governance\n');
  assert.ok('epic' in parseEpicFile('stories/EP-3/_epic.md', empty));
});

const bad = (path: string, text: string) => {
  const r = parseStoryFile(path, text);
  assert.ok('issues' in r, 'expected issues');
  return r.issues;
};
const head = (extra = '') => `---\nid: US-1\nepic: EP-1\ntitle: t\nstate: draft${extra}\n---\n`;

test('NEGATIVE issues carry path, line and a fix', () => {
  const missingThen = bad('stories/EP-1/US-1.md', `${head()}## Acceptance criteria\n### AC-1 x\n- Given a\n- When b\n`);
  assert.equal(missingThen[0].path, 'stories/EP-1/US-1.md');
  assert.equal(missingThen[0].line, 8);
  assert.match(missingThen[0].reason, /AC-1 has no 'Then'/);
  assert.ok(missingThen[0].fix.length > 0);

  assert.match(bad('stories/EP-1/US-1.md', `${head()}## Acceptance criteria\n### AC-1 x\n- When b\n- Given a\n- Then c\n`)[0].reason, /comes after/);
  assert.match(bad('stories/EP-1/US-1.md', `${head()}## Acceptance criteria\n### AC-1 x\n- And a\n`)[0].reason, /'And' has no/);
  assert.match(bad('stories/EP-1/US-1.md', `${head()}## Acceptance criteria\n### AC-1 x\n- Given a\n- When b\n- Then c\n### AC-1 y\n- Given a\n- When b\n- Then c\n`)[0].reason, /appears twice/);
  assert.match(bad('stories/EP-1/US-1.md', `${head()}Some prose\n## Acceptance criteria\n`)[0].reason, /unexpected text/);
  assert.match(bad('stories/EP-1/US-1.md', `${head()}## Acceptance criteria\n## Extra\n`)[0].reason, /unknown section/);
  assert.match(bad('stories/EP-1/US-1.md', head())[0].reason, /no '## Acceptance criteria'/);
  assert.match(bad('stories/EP-1/US-1.md', `${head('\nowner: me')}## Acceptance criteria\n`)[0].reason, /unknown front-matter key 'owner'/);
  assert.match(bad('stories/EP-1/US-1.md', `---\nid: US-1\nepic: EP-1\ntitle: t\nstate: built\n---\n## Acceptance criteria\n`)[0].reason, /not a story state/);
  assert.match(bad('stories/EP-1/US-1.md', `id: US-1\n`)[0].reason, /does not start with front matter/);
  assert.match(bad('stories/EP-1/US-1.md', `---\nid: US-1\n`)[0].reason, /not closed/);
  assert.match(bad('stories/EP-1/US-1.md', `---\nid: US-1\nepic: EP-1\ntitle: 'q'\nstate: draft\n---\n## Acceptance criteria\n`)[0].reason, /single quotes/);
});

test('NEGATIVE the file name and folder must carry the ids the front matter states', () => {
  assert.match(bad('stories/EP-1/US-2.md', `${head()}## Acceptance criteria\n`)[0].reason, /file name says US-2/);
  assert.match(bad('stories/EP-2/US-1.md', `${head()}## Acceptance criteria\n`)[0].reason, /folder of EP-2/);
  const e = parseEpicFile('stories/EP-2-x/_epic.md', '---\nid: EP-1\ntitle: t\n---\n## Requirements\n### Technical\n### UX\n### Governance\n');
  assert.ok('issues' in e);
  assert.match(e.issues[0].reason, /folder says EP-2/);
});

test('NEGATIVE size limits: a file over the byte limit is refused before parsing', () => {
  const huge = `${head()}## Acceptance criteria\n\n## Notes\n${'x'.repeat(SPEC_LIMITS.fileBytes)}`;
  assert.match(bad('stories/EP-1/US-1.md', huge)[0].reason, /larger than/);
});

test('NEGATIVE epic structure: requirements headings exact and in order', () => {
  const r = parseEpicFile('stories/EP-1/_epic.md', '---\nid: EP-1\ntitle: t\n---\n## Requirements\n### UX\n### Technical\n### Governance\n');
  assert.ok('issues' in r);
  assert.match(r.issues[0].reason, /out of order/);
  const r2 = parseEpicFile('stories/EP-1/_epic.md', '---\nid: EP-1\ntitle: t\n---\nhello\n');
  assert.ok('issues' in r2);
  assert.match(r2.issues[0].reason, /no '## Requirements'/);
});

test('validateStoryDoc refuses what would not read back: line breaks, ** in the story line, empty keywords', () => {
  const ok = gen(4);
  assert.match(validateStoryDoc({ ...ok, title: 'a\nb' })[0].reason, /line break/);
  assert.match(validateStoryDoc({ ...ok, asA: 'a **b**' }).map((i) => i.reason).join(), /contains '\*\*'/);
  assert.match(validateStoryDoc({ ...ok, criteria: [{ id: 'AC-1', title: '', given: [], when: ['x'], then: ['y'] }] })[0].reason, /no Given/);
  assert.match(validateStoryDoc({ ...ok, notes: 'x  ' })[0].reason, /end with whitespace/);
  assert.match(validateEpicDoc({ id: 'EP-1', title: 't', description: '## Requirements', requirements: { technical: '', ux: '', governance: '' } })[0].reason, /'## ' or '### '/);
});

test('classifyStoryPath admits only the layout; traversal and odd names never classify', () => {
  assert.deepEqual(classifyStoryPath('stories/EP-1-order-intake/US-3-submit-order.md'), { kind: 'story', epic: 'EP-1', story: 'US-3', dir: 'EP-1-order-intake' });
  assert.deepEqual(classifyStoryPath('stories/EP-12/_epic.md'), { kind: 'epic', epic: 'EP-12', dir: 'EP-12' });
  assert.deepEqual(classifyStoryPath('stories/README.md'), { kind: 'readme' });
  for (const p of [
    'stories/../src/app.ts',
    'stories/EP-1/../../x.md',
    '/stories/EP-1/US-1.md',
    'stories/EP-1/US-1.md/x',
    'stories/EP-01/US-1.md',
    'stories/EP-1/US-0.md',
    'stories/EP-1/.US-1.md',
    'stories\\EP-1\\US-1.md',
    'stories/EP-1/US-1.MD',
    'stories/EP-1-Upper/US-1.md',
    'stories/EP-1/nested/US-1.md',
    'src/stories/EP-1/US-1.md',
    'stories/EP-1/US-1-.md',
  ]) {
    assert.equal(classifyStoryPath(p), null, p);
  }
});

test('paths for new files: slug is ASCII and cosmetic, the id leads', () => {
  assert.equal(slugOf('Bestellung übermitteln!'), 'bestellung-ubermitteln');
  assert.equal(slugOf('***'), '');
  assert.equal(epicPath('EP-4', 'Order intake'), 'stories/EP-4-order-intake/_epic.md');
  assert.equal(epicPath('EP-4', '***'), 'stories/EP-4/_epic.md');
  assert.equal(storyPath({ path: 'stories/EP-4-order-intake/_epic.md' }, 'US-9', 'Submit'), 'stories/EP-4-order-intake/US-9-submit.md');
  assert.ok(classifyStoryPath(storyPath({ path: epicPath('EP-1', 'x'.repeat(200)) }, 'US-1', 'y'.repeat(200))));
});

test('parseLivingSpec: sorted by number, duplicates named with both paths, orphans and foreign files reported', () => {
  const epic = (id: string, dir: string) => ({ path: `stories/${dir}/_epic.md`, content: renderEpicFile({ id: id as EpicDoc['id'], title: id, description: '', requirements: { technical: '', ux: '', governance: '' } }) });
  const story = (id: string, epicId: string, dir: string, name = '') => ({ path: `stories/${dir}/${id}${name}.md`, content: renderStoryFile({ ...gen(3), id: id as StoryDoc['id'], epic: epicId as StoryDoc['epic'] }) });
  const { spec, issues } = parseLivingSpec(
    [
      epic('EP-10', 'EP-10-b'),
      epic('EP-2', 'EP-2-a'),
      story('US-11', 'EP-2', 'EP-2-a'),
      story('US-3', 'EP-2', 'EP-2-a'),
      story('US-3', 'EP-10', 'EP-10-b', '-copy'),
      story('US-4', 'EP-7', 'EP-7-orphan'),
      { path: 'stories/notes.txt', content: 'x' },
      { path: 'stories/README.md', content: 'docs' },
    ],
    'abc',
  );
  assert.equal(spec.sha, 'abc');
  assert.deepEqual(spec.epics.map((e) => e.id), ['EP-2', 'EP-10']);
  assert.deepEqual(spec.stories.map((s) => s.id), ['US-3', 'US-11']);
  const reasons = issues.map((i) => i.reason).join('\n');
  assert.match(reasons, /US-3 is used twice: stories\/EP-10-b\/US-3-copy\.md and stories\/EP-2-a\/US-3\.md|US-3 is used twice: stories\/EP-2-a\/US-3\.md and stories\/EP-10-b\/US-3-copy\.md/);
  assert.match(reasons, /has no _epic\.md/);
  assert.match(reasons, /not part of the living spec layout/);
  const twoDirs = parseLivingSpec([epic('EP-1', 'EP-1-a'), epic('EP-1', 'EP-1-b')], 's');
  assert.match(twoDirs.issues[0].reason, /EP-1 has two folders/);
});
