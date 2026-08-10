/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { App } from '@/lib/software/apps';
import {
  asBuildTarget,
  buildGate,
  resolveTarget,
  stageDirective,
  targetProgress,
} from './mcp-stages.ts';

/** A minimal App fixture with two stories: one specified, one not, one done. */
function appFixture(): App {
  return {
    id: 'app_x',
    slug: 'x',
    name: 'X',
    description: '',
    purpose: 'Track things',
    template: 'sovereign-app',
    epics: [
      {
        id: 'e1',
        title: 'Epic One',
        description: '',
        requirements: { technical: '', ux: '', governance: '' },
        stories: [
          { id: 's1', title: 'Specced', asA: 'user', iWant: 'a thing', soThat: 'value', acceptance: 'works', status: 'done', spec: { features: ['F1', 'F2'], nfrs: [], rules: ['R1'] } },
          { id: 's2', title: 'Bare', asA: 'user', iWant: 'more', soThat: 'value', acceptance: '' },
        ],
      },
    ],
  } as unknown as App;
}

test('asBuildTarget coerces kinds and infers from ids', () => {
  assert.deepEqual(asBuildTarget(undefined), { kind: 'app' });
  assert.deepEqual(asBuildTarget({ kind: 'epic', epicId: 'e1' }), { kind: 'epic', epicId: 'e1' });
  assert.deepEqual(asBuildTarget({ kind: 'story', epicId: 'e1', storyId: 's1' }), { kind: 'story', epicId: 'e1', storyId: 's1' });
  // Missing `kind` but ids present → inferred.
  assert.deepEqual(asBuildTarget({ epicId: 'e1', storyId: 's1' }), { kind: 'story', epicId: 'e1', storyId: 's1' });
  assert.deepEqual(asBuildTarget({ epicId: 'e1' }), { kind: 'epic', epicId: 'e1' });
});

test('resolveTarget flags a non-existent epic/story as notFound', () => {
  const app = appFixture();
  assert.equal(resolveTarget(app, { kind: 'app' }).notFound, false);
  assert.equal(resolveTarget(app, { kind: 'story', epicId: 'e1', storyId: 's1' }).notFound, false);
  assert.equal(resolveTarget(app, { kind: 'story', epicId: 'e1', storyId: 'nope' }).notFound, true);
  assert.equal(resolveTarget(app, { kind: 'epic', epicId: 'nope' }).notFound, true);
});

test('DESIGN-BEFORE-BUILD GATE: a specced story passes; a bare story fails and is named', () => {
  const app = appFixture();
  // The specced, design-complete story builds.
  assert.equal(buildGate(app, { kind: 'story', epicId: 'e1', storyId: 's1' }).ok, true);
  // The bare story is blocked and named.
  const bare = buildGate(app, { kind: 'story', epicId: 'e1', storyId: 's2' });
  assert.equal(bare.ok, false);
  assert.equal(bare.ok === false && bare.unspecified.some((u) => u.storyId === 's2'), true);
  // The whole app is NOT design-complete (s2 has no spec).
  assert.equal(buildGate(app, { kind: 'app' }).ok, false);
});

test('stageDirective embeds the mode directive, Define context, spec + tier', () => {
  const app = appFixture();
  const build = stageDirective(app, { kind: 'story', epicId: 'e1', storyId: 's1' }, 'build');
  assert.match(build, /Mode: BUILD/);
  assert.match(build, /Context from Define/);
  assert.match(build, /Track things/); // purpose
  assert.match(build, /Features to build: F1; F2/);
  assert.match(build, /reasoning model/); // Build now runs on reasoning too (0.6.95)
  const test5 = stageDirective(app, { kind: 'story', epicId: 'e1', storyId: 's1' }, 'test');
  assert.match(test5, /Mode: TEST/);
  assert.match(test5, /reasoning model/);
});

test('targetProgress is honest — built only when the story is done', () => {
  const app = appFixture();
  const p = targetProgress(app, { kind: 'epic', epicId: 'e1' });
  assert.equal(p.storiesTotal, 2);
  assert.equal(p.storiesBuilt, 1); // only s1 is done
  // s1 has 3 spec items, all counted built; s2 has none.
  assert.equal(p.itemsBuilt, 3);
  assert.equal(p.itemsTotal, 3);
});
