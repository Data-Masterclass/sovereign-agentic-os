/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/auth';
import { createApp } from '@/lib/apps';
import { authorizeConnectionCall } from '@/lib/agent-governed';
import { archiveApp, unarchiveApp, deleteApp, useAsData, consumeResource, dependentsOf } from './lifecycle.ts';
import { getAppByIdInternal } from '@/lib/apps';

const owner: CurrentUser = { id: 'carol', name: 'Carol', domains: ['ops'], role: 'participant' };

async function expectStatus(p: Promise<unknown>, status: number, re?: RegExp) {
  await assert.rejects(p, (e: Error & { status?: number }) => {
    assert.equal(e.status, status);
    if (re) assert.match(e.message, re);
    return true;
  });
}

test('archive disables the MCP but RETAINS the data artifact (restorable)', async () => {
  const app = await createApp(owner, { name: 'Inventory L1', template: 'nextjs-supabase' });
  const readTool = app.mcpTools.find((t) => !t.write)!.name;
  assert.equal(authorizeConnectionCall(app.mcpPrincipal, readTool).effect, 'allow');

  const archived = await archiveApp(app.id, owner);
  assert.equal(archived.status, 'archived');
  // MCP disabled: the tool is no longer exposed/governed (deny).
  assert.equal(authorizeConnectionCall(app.mcpPrincipal, readTool).effect, 'deny');
  // Data retained.
  assert.equal(archived.dataArtifactId, app.dataArtifactId);

  const restored = await unarchiveApp(app.id, owner);
  assert.equal(restored.status, 'active');
  assert.equal(authorizeConnectionCall(app.mcpPrincipal, readTool).effect, 'allow');
});

test('consume rejects a raw credential; records a reference (no embedded creds)', async () => {
  const app = await createApp(owner, { name: 'Inventory L2', template: 'service' });
  await expectStatus(
    consumeResource(app.id, owner, { kind: 'connection', ref: 'password=hunter2', label: 'x', scope: 'read' }),
    400,
    /reference, never a raw credential/,
  );
  const updated = await consumeResource(app.id, owner, { kind: 'connection', ref: 'salesforce', label: 'Salesforce', scope: 'read' });
  assert.equal(updated.consumes.some((c) => c.ref === 'salesforce'), true);
});

test('delete is lineage-aware — blocked while a dependency is in use', async () => {
  const dep = await createApp(owner, { name: 'Shared Renewals API', template: 'service' });
  const consumer = await createApp(owner, { name: 'Sales Dashboard', template: 'dashboard' });
  // The consumer app uses the dependency's MCP.
  await consumeResource(consumer.id, owner, { kind: 'app-mcp', ref: dep.mcpPrincipal, label: 'Renewals API MCP', scope: 'read' });

  const deps = await dependentsOf((await getAppByIdInternal(dep.id))!);
  assert.equal(deps.length >= 1, true);
  // Deleting the depended-on app is blocked.
  await expectStatus(deleteApp(dep.id, owner), 409, /Delete blocked/);
  // Deleting the consumer first is fine, then the dependency unblocks.
  assert.deepEqual(await deleteApp(consumer.id, owner), { deleted: true });
  assert.deepEqual(await deleteApp(dep.id, owner), { deleted: true });
});

test('Use as Data marks the Bronze snapshot', async () => {
  const app = await createApp(owner, { name: 'Inventory L4', template: 'nextjs-supabase' });
  const updated = await useAsData(app.id, owner);
  assert.equal(updated.usedAsData, true);
});
