/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * served-app.test — the PURE serve-target routing decision for `/apps/<slug>` (Phase 3):
 *   • an image app (or a legacy record with no serveMode) → 'image-elsewhere'
 *   • a spec app WITH a non-empty spec → 'spec'
 *   • spec mode but an ABSENT / empty-tabs spec → 'none' (honest, not blank)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveServeTarget } from './served-app.ts';
import type { App } from './apps.ts';
import type { AppSpec } from './appspec/schema.ts';

const oneTab: AppSpec = {
  version: 2,
  name: 'App',
  description: 'x',
  tabs: [
    {
      id: 't1',
      label: 'Records',
      body: {
        kind: 'pattern',
        pattern: 'records-table',
        config: { source: { datasetId: 'ds_x' }, columns: [{ field: 'id' }] },
      },
    },
  ],
};

/** Minimal App the pure resolver reads — only `serveMode` + `spec` matter. */
function app(serveMode: App['serveMode'], spec?: AppSpec): Pick<App, 'serveMode' | 'spec'> {
  return { serveMode, spec };
}

test('an image app → image-elsewhere', () => {
  assert.deepEqual(resolveServeTarget(app('image')), { kind: 'image-elsewhere' });
});

test('a legacy record with NO serveMode → image-elsewhere (nil-safe default)', () => {
  assert.deepEqual(resolveServeTarget(app(undefined)), { kind: 'image-elsewhere' });
});

test('a runtime app → image-elsewhere (not served by this route)', () => {
  assert.deepEqual(resolveServeTarget(app('runtime')), { kind: 'image-elsewhere' });
});

test('a spec app WITH a non-empty spec → spec', () => {
  assert.deepEqual(resolveServeTarget(app('spec', oneTab)), { kind: 'spec' });
});

test('spec mode but an ABSENT spec → none', () => {
  assert.deepEqual(resolveServeTarget(app('spec', undefined)), { kind: 'none' });
});

test('spec mode but an EMPTY-tabs spec → none', () => {
  const empty: AppSpec = { ...oneTab, tabs: [] };
  assert.deepEqual(resolveServeTarget(app('spec', empty)), { kind: 'none' });
});
