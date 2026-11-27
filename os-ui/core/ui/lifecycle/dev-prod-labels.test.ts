/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       ui
 * FEATURE:    App Builder (F) - Studio | Run reads Dev | Prod only while the App Builder is on
 * USER STORY: As a user on an install with the App Builder on, the header says Dev | Prod; on an install with it off
 *             (prod today) it still says Studio | Run, the preference read answers exactly as before, and the stored
 *             ids stay `studio` / `run`.
 * ARCHITECTURE: the pure label functions (core/kernel/object-lifecycle.ts), the seven `shell` catalogs, the preference
 *             route over a stand-in session, and — because a test cannot import a .tsx — the toggle's source.
 */
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VIEW_SURFACES,
  VIEW_SURFACE_LABELS,
  VIEW_SURFACE_LABELS_APP_BUILDER,
  viewSurfaceLabel,
  viewSurfaceLabelKey,
} from '@core/kernel/object-lifecycle';

const realAuth = await import('@core/kernel/auth');
mock.module('@core/kernel/auth', {
  namedExports: { ...realAuth, requireUser: async () => ({ id: 'cora', name: 'cora', role: 'creator', domains: ['sales'] }) },
});
mock.module('@core/prefs/view-surface', {
  namedExports: { getViewSurface: async () => 'studio', setViewSurface: async () => undefined, isViewSurface: (v: unknown) => v === 'studio' || v === 'run' },
});
const { GET } = await import('@/app/api/prefs/view-surface/route');

const here = dirname(fileURLToPath(import.meta.url));
const osUi = resolve(here, '../../..');
const LOCALES = ['en', 'de', 'fr', 'es', 'it', 'pl', 'cs'];

afterEach(() => { delete process.env.SOFTWARE_APP_BUILDER; });

test('labels: Studio / Run with the switch off, Dev / Prod with it on; ids unchanged', () => {
  assert.deepEqual([...VIEW_SURFACES], ['studio', 'run'], 'the ids are load-bearing and never change');
  assert.deepEqual(VIEW_SURFACE_LABELS, { studio: 'Studio', run: 'Run' });
  assert.deepEqual(VIEW_SURFACE_LABELS_APP_BUILDER, { studio: 'Dev', run: 'Prod' });
  assert.deepEqual(VIEW_SURFACES.map((s) => viewSurfaceLabel(s, false)), ['Studio', 'Run']);
  assert.deepEqual(VIEW_SURFACES.map((s) => viewSurfaceLabel(s, true)), ['Dev', 'Prod']);
  assert.deepEqual(VIEW_SURFACES.map((s) => viewSurfaceLabelKey(s, false)), ['studio', 'run']);
  assert.deepEqual(VIEW_SURFACES.map((s) => viewSurfaceLabelKey(s, true)), ['dev', 'prod']);
});

test('catalogs: every locale keeps Studio / Run as they were and adds the Dev / Prod keys', () => {
  for (const l of LOCALES) {
    const shell = JSON.parse(readFileSync(resolve(osUi, 'messages', l, 'shell.json'), 'utf8')) as { surface: Record<string, string> };
    for (const k of ['group', 'studio', 'run', 'studioHint', 'runHint', 'groupDevProd', 'dev', 'prod', 'devHint', 'prodHint']) {
      assert.ok(typeof shell.surface[k] === 'string' && shell.surface[k].length > 0, `${l}: shell.surface.${k}`);
    }
    assert.equal(shell.surface.dev, 'Dev');
    assert.equal(shell.surface.prod, 'Prod');
  }
  const en = JSON.parse(readFileSync(resolve(osUi, 'messages/en/shell.json'), 'utf8')) as { surface: Record<string, string> };
  assert.equal(en.surface.studio, 'Studio');
  assert.equal(en.surface.run, 'Run');
  assert.equal(en.surface.group, 'Studio or Run');
});

test('the toggle picks its keys through viewSurfaceLabelKey and the App Builder flag (source check: a .tsx cannot be imported)', () => {
  const src = readFileSync(resolve(here, 'StudioRunToggle.tsx'), 'utf8');
  assert.match(src, /useAppBuilderFlag\(\)/);
  assert.match(src, /viewSurfaceLabelKey\(s, appBuilder\)/);
  assert.match(src, /appBuilder \? 'surface\.groupDevProd' : 'surface\.group'/);
  assert.match(src, /onClick=\{\(\) => setSurface\(s\)\}/, 'the stored id is still the surface id, never the label');
});

test('preference read, switch OFF: exactly { surface } as before (no new field, no extra request)', async () => {
  delete process.env.SOFTWARE_APP_BUILDER;
  const res = await GET(new Request('http://os.test/api/prefs/view-surface'), { params: Promise.resolve({}) });
  assert.deepEqual(await res.json(), { surface: 'studio' });
});

test('preference read, switch ON: the same answer adds appBuilder: true', async () => {
  process.env.SOFTWARE_APP_BUILDER = 'on';
  const res = await GET(new Request('http://os.test/api/prefs/view-surface'), { params: Promise.resolve({}) });
  assert.deepEqual(await res.json(), { surface: 'studio', appBuilder: true });
});
