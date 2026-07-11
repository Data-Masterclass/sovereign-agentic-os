/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { createApp } from '@/lib/software/apps';
import { consumeResource } from './lifecycle.ts';
import { renderAppYaml } from './metadata.ts';
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

/**
 * `declares.knowledge` is AUTHORITATIVE for the app's KNOWLEDGE consumes/lineage
 * edges. A re-commit of app.yaml that DROPS a knowledge ref must drop the stale
 * consumes edge (previously the commit only ever UNIONED, so the edge persisted and
 * blocked deleting the now-unreferenced knowledge). Data/connection consumes,
 * recorded through other governed paths, must be unaffected.
 */
test('commit reconciles knowledge consumes to declares — removed ref drops the edge, others intact', async () => {
  const app = await createApp(dev, { name: 'Declares Authoritative', template: 'service' });

  // Seed two knowledge edges + an unrelated connection edge (as `consumeResource` would).
  await consumeResource(app.id, dev, { kind: 'knowledge', ref: 'wf_keep', label: 'Keep', scope: 'read' });
  await consumeResource(app.id, dev, { kind: 'knowledge', ref: 'wf_stale', label: 'Stale', scope: 'read' });
  await consumeResource(app.id, dev, { kind: 'connection', ref: 'salesforce', label: 'Salesforce', scope: 'read' });

  // Commit app.yaml declaring ONLY wf_keep + a NEW wf_new (wf_stale removed).
  const appYaml = renderAppYaml({
    name: app.name,
    owner: app.owner,
    description: app.description,
    knowledge: ['wf_keep', 'wf_new'],
  });
  const { app: after } = await commitToApp(
    app.id,
    dev,
    [{ path: 'app.yaml', content: appYaml }],
    'declare knowledge (drop wf_stale, add wf_new)',
  );

  const knowledge = after.consumes.filter((c) => c.kind === 'knowledge').map((c) => c.ref).sort();
  assert.deepEqual(knowledge, ['wf_keep', 'wf_new'], 'wf_stale pruned, wf_new added — declares is authoritative');
  // Retained ref keeps its prior label (not clobbered).
  assert.equal(after.consumes.find((c) => c.ref === 'wf_keep')!.label, 'Keep');
  // Unrelated connection consume is untouched.
  assert.ok(after.consumes.some((c) => c.kind === 'connection' && c.ref === 'salesforce'));
  // The manifest agrees.
  assert.deepEqual([...after.manifest.knowledge].sort(), ['wf_keep', 'wf_new']);
});
