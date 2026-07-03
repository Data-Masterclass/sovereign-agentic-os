/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/auth';
import { createApp } from '@/lib/apps';
import { commitToApp, getSnapshot } from './server.ts';

const dev: CurrentUser = { id: 'dan', name: 'Dan', domains: ['eng'], role: 'creator' };

/**
 * A commit is a CHANGESET, not the whole tree. `commitToApp` must merge the
 * changed files over the app's existing tree (prior snapshot or template seed)
 * before it parses metadata / detects surface / scans — otherwise a normal
 * partial commit clobbers the app.yaml/openapi/.app metadata and hides the rest
 * of the repo from the security scan. ("Whatever is committed is seen in the app"
 * must not mean "everything NOT in this one commit disappears.")
 */
test('a partial commit preserves the app metadata + full-tree scan (merge, not replace)', async () => {
  const app = await createApp(dev, { name: 'Merge Fidelity', template: 'nextjs-supabase' });
  // Sanity: a fresh nextjs-supabase app has a complete manifest + both surfaces.
  assert.equal(app.manifest.hasOpenApi, true);
  assert.equal(app.manifest.missing.length, 0);
  assert.equal(app.surface.ui, true);
  assert.equal(app.surface.api, true);

  // Commit ONE new UI file (a realistic changeset — not the whole repo).
  const { app: after } = await commitToApp(
    app.id,
    dev,
    [{ path: 'app/reports/page.tsx', content: 'export default function P(){return null}\n' }],
    'add reports page',
  );

  // The convention files (app.yaml / openapi.yaml / .app/decisions.md) are still
  // seen, so the manifest is intact and the auto-MCP still has its tools.
  assert.equal(after.manifest.hasOpenApi, true, 'openapi.yaml must survive a partial commit');
  assert.equal(after.manifest.missing.length, 0, 'no metadata should go "missing" on a partial commit');
  assert.equal(after.surface.ui, true);
  assert.equal(after.surface.api, true);

  // The snapshot the scan/diff read from is the WHOLE tree (template seed + the
  // new file), not just the one changed file.
  const snap = getSnapshot(app.id);
  assert.ok(snap && snap.length > 1, 'snapshot must be the merged tree');
  assert.ok(snap!.some((f) => f.path === 'app/reports/page.tsx'), 'includes the committed file');
  assert.ok(snap!.some((f) => f.path === 'openapi.yaml'), 'still includes the seeded openapi.yaml');
});
