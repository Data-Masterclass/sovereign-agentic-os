/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPreviewShape, unsupportedShapeMessage } from './preview-shape.ts';

test('detectPreviewShape: a Vite entry wins, in boot order', () => {
  assert.deepEqual(detectPreviewShape(['src/main.tsx', 'src/App.tsx']), { kind: 'vite', entry: '/src/main.tsx' });
  assert.deepEqual(detectPreviewShape(['src/index.tsx']), { kind: 'vite', entry: '/src/index.tsx' });
  // Leading slashes are normalised.
  assert.deepEqual(detectPreviewShape(['/src/main.ts']), { kind: 'vite', entry: '/src/main.ts' });
  // main.tsx beats index.tsx when both exist.
  assert.deepEqual(detectPreviewShape(['src/index.tsx', 'src/main.tsx']), { kind: 'vite', entry: '/src/main.tsx' });
});

test('detectPreviewShape: the legacy Next.js scaffold is recognised, not an opaque error', () => {
  // The exact shape the old nextjs-supabase template seeds (the Northpeak case).
  const nextApp = ['package.json', 'app/layout.tsx', 'app/page.tsx', 'Dockerfile', 'app.yaml', 'openapi.yaml'];
  assert.deepEqual(detectPreviewShape(nextApp), { kind: 'nextjs' });
  // A pages-router app is also Next-style.
  assert.deepEqual(detectPreviewShape(['pages/index.tsx']), { kind: 'nextjs' });
});

test('detectPreviewShape: anything else is honestly unknown', () => {
  assert.deepEqual(detectPreviewShape(['README.md', 'server.mjs']), { kind: 'unknown' });
  assert.deepEqual(detectPreviewShape([]), { kind: 'unknown' });
});

test('unsupportedShapeMessage: honest guidance per shape; null for vite', () => {
  assert.equal(unsupportedShapeMessage({ kind: 'vite', entry: '/src/main.tsx' }), null);
  assert.match(unsupportedShapeMessage({ kind: 'nextjs' })!, /legacy\s*Next\.js scaffold/i);
  assert.match(unsupportedShapeMessage({ kind: 'nextjs' })!, /deployed preview/);
  assert.match(unsupportedShapeMessage({ kind: 'unknown' })!, /src\/main\.tsx/);
});
