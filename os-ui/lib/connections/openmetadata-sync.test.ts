/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyVersions, type Dataset } from '@/lib/data/dataset-schema';
import {
  buildAdditivePatch,
  omVersionWritable,
  TESTED_OM_MIN,
  TESTED_OM_MAX,
  type OmPatchOp,
  type OmWrite,
} from '@/lib/data/openmetadata';
import {
  buildOmSyncPlan,
  previewOmSync,
  applyOmSync,
  provisionOmNamespace,
  omProvisionPlan,
  OS_SERVICE,
  OS_DOMAIN,
  MANAGED_BY,
  type OmSyncClient,
} from '@/lib/connections/openmetadata-sync';

// --- A promoted product Dataset factory (Gold built) ---------------------------
function product(over: Partial<Dataset> = {}): Dataset {
  const versions = emptyVersions();
  versions.bronze.built = true;
  versions.silver.built = true;
  versions.gold.built = true;
  return {
    version: '1',
    id: 'ds_orders',
    name: 'Orders',
    owner: 'amir',
    domain: 'sales',
    tier: 'product',
    visibility: 'shared',
    description: 'Sales orders product.',
    versions,
    grants: [],
    measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount' }],
    columns: [
      { name: 'order_id', description: 'Key.' },
      { name: 'net_amount', description: 'Value.' },
    ],
    ...over,
  };
}

// --- A FAKE OM sync client — records every call, no network --------------------
type Call = { kind: string; path: string; body?: unknown };
function fakeClient(over: Partial<OmSyncClient> = {}): { client: OmSyncClient; calls: Call[] } {
  const calls: Call[] = [];
  const ok: OmWrite = { ok: true, data: {} };
  const client: OmSyncClient = {
    omVersion: '1.5.0',
    readEntityMeta: async () => null, // does not exist yet → a fresh OS create
    putEntity: async (path, body) => { calls.push({ kind: 'put', path, body }); return ok; },
    patchEntity: async (entityPath, ops) => { calls.push({ kind: 'patch', path: entityPath, body: ops }); return ok; },
    putLineage: async (edge) => { calls.push({ kind: 'lineage', path: `${edge.fromFqn}->${edge.toFqn}` }); return ok; },
    ...over,
  };
  return { client, calls };
}

// ============================ THE GUARDS =======================================

test('G1: the plan only PUTs inside the sovereign_os Service / OS Domain', () => {
  const plan = buildOmSyncPlan(product(), { runId: 'run1', humanServiceFqn: 'trino_prod' });
  assert.ok(plan.puts.length >= 1, 'a product with gold built produces at least the table + product PUTs');
  for (const p of plan.puts) {
    const inNamespace = p.fqn.startsWith(`${OS_SERVICE}.`) || p.fqn.startsWith(`${OS_DOMAIN}.`);
    assert.ok(inNamespace, `every PUT stays in the OS namespace — got ${p.fqn}`);
  }
});

test('G2: no JSON-Patch op is ever `remove`, and no human-authored path is replaced', () => {
  const plan = buildOmSyncPlan(product(), { runId: 'run1', humanServiceFqn: 'trino_prod' });
  assert.ok(plan.patches.length >= 1, 'annotating the human mart produces a patch');
  for (const pt of plan.patches) {
    for (const op of pt.ops) {
      assert.notEqual((op as { op: string }).op, 'remove', 'a remove op must NEVER appear');
      // The only mutating ops touch tags/- or our OWN extension/os* keys — never a
      // human-authored field like /description or /owner.
      if (op.op === 'add' || op.op === 'replace') {
        const humanPath = op.path === '/description' || op.path.startsWith('/owner') || op.path.startsWith('/displayName');
        assert.ok(!humanPath, `additive patch never touches a human field — got ${op.path}`);
      }
    }
  }
});

test('G2: buildAdditivePatch THROWS on a smuggled remove op', () => {
  const smuggled = [{ op: 'remove', path: '/description' }] as unknown as OmPatchOp[];
  assert.throws(() => buildAdditivePatch(smuggled), /only add\/replace\/test/);
});

test('G3: every OS-created entity is stamped managedBy=SovereignOS + osDatasetId', () => {
  const plan = buildOmSyncPlan(product({ id: 'ds_xyz' }), { runId: 'run7' });
  for (const p of plan.puts) {
    const ext = (p.body as { extension?: Record<string, unknown> }).extension ?? {};
    assert.equal(ext.managedBy, MANAGED_BY, 'managedBy marker present');
    assert.equal(ext.osDatasetId, 'ds_xyz', 'osDatasetId keyed to the dataset');
    assert.equal(ext.osRunId, 'run7', 'osRunId records the sync run');
  }
});

test('G4: re-sync is idempotent — apply twice yields the same additive calls', async () => {
  const plan = buildOmSyncPlan(product(), { runId: 'run1' });
  const a = fakeClient();
  const r1 = await applyOmSync(a.client, plan);
  const b = fakeClient();
  const r2 = await applyOmSync(b.client, plan);
  assert.deepEqual(r1.applied, r2.applied, 'the same plan applies identically (idempotent)');
  assert.equal(r1.ok && r2.ok, true);
  // No destructive verb exists on the client at all (no delete surface).
  for (const c of [...a.calls, ...b.calls]) {
    assert.ok(['put', 'patch', 'lineage'].includes(c.kind), `only additive verbs — got ${c.kind}`);
  }
});

test('G5: optimistic concurrency — a human edit since last sync YIELDS (no overwrite)', async () => {
  const plan = buildOmSyncPlan(product(), { runId: 'run1', humanServiceFqn: 'trino_prod' });
  const { client, calls } = fakeClient({
    // The human mart was last edited by a real person, not our writer bot.
    readEntityMeta: async () => ({ version: 3.2, updatedBy: 'alice' }),
  });
  const res = await applyOmSync(client, plan, { lastSyncUpdatedBy: 'sovereign-os-writer' });
  assert.equal(res.conflicts.length, 1, 'the human-edited table is a recorded conflict');
  assert.match(res.conflicts[0].reason, /human edit by alice/);
  // We YIELDED: no PATCH was sent for the conflicted target.
  assert.equal(calls.filter((c) => c.kind === 'patch').length, 0, 'no patch sent when a human edited');
});

test('G5: OM 412 (test precondition failed) is recorded as a conflict, not an error', async () => {
  const plan = buildOmSyncPlan(product(), { runId: 'run1', humanServiceFqn: 'trino_prod' });
  const { client } = fakeClient({
    readEntityMeta: async () => null, // no prior-sync mismatch
    patchEntity: async () => ({ ok: false, reason: 'precondition failed', conflict: true }),
  });
  const res = await applyOmSync(client, plan);
  assert.equal(res.conflicts.length, 1, 'a 412 becomes a conflict');
  assert.equal(res.errors.length, 0, 'a 412 is NOT a hard error');
});

test('G6: preview never mutates — it issues zero client calls and reports 0 human fields', () => {
  const plan = buildOmSyncPlan(product(), { runId: 'run1', humanServiceFqn: 'trino_prod' });
  const preview = previewOmSync(plan);
  assert.equal(preview.ok, true);
  assert.equal(preview.counts.humanFieldsTouched, 0, 'ZERO human fields touched — structural');
  assert.match(preview.summary, /touch ZERO human fields/);
  assert.ok(preview.lines.length > 0, 'the diff lists every op');
});

test('write refused on an OM version outside the tested range', async () => {
  const plan = buildOmSyncPlan(product(), { runId: 'run1' });
  const { client, calls } = fakeClient({ omVersion: '2.0.0' }); // above TESTED_OM_MAX
  const res = await applyOmSync(client, plan);
  assert.equal(res.ok, false);
  assert.match(res.refused ?? '', /outside the tested write range/);
  assert.equal(calls.length, 0, 'nothing was written on a refused version');
});

test('omVersionWritable: in-range passes, out-of-range + unknown fail closed', () => {
  assert.equal(omVersionWritable('1.5.0'), true);
  assert.equal(omVersionWritable(TESTED_OM_MIN), true);
  assert.equal(omVersionWritable(TESTED_OM_MAX), true);
  assert.equal(omVersionWritable('1.2.0'), false, 'below min');
  assert.equal(omVersionWritable('2.0.0'), false, 'above max');
  assert.equal(omVersionWritable(undefined), false, 'unknown → fail closed');
  assert.equal(omVersionWritable('not-a-version'), false, 'unparseable → fail closed');
});

test('a non-promoted dataset (tier=dataset) is rejected — nothing to publish', () => {
  const plan = buildOmSyncPlan(product({ tier: 'dataset' }), { runId: 'run1' });
  assert.ok(plan.rejected, 'rejected');
  assert.match(plan.rejected!, /promote/i);
  assert.equal(previewOmSync(plan).ok, false);
});

test('a dataset with no built Gold is rejected', () => {
  const noGold = product();
  noGold.versions.gold.built = false;
  const plan = buildOmSyncPlan(noGold, { runId: 'run1' });
  assert.match(plan.rejected ?? '', /Gold layer is not built/);
});

test('apply REFUSES a plan whose PUT somehow escapes the OS namespace (G1 defence)', async () => {
  const plan = buildOmSyncPlan(product(), { runId: 'run1' });
  // Tamper: point a PUT at a human FQN.
  plan.puts[0] = { ...plan.puts[0], fqn: 'trino_prod.iceberg.sales.gold_orders' };
  const { client, calls } = fakeClient();
  const res = await applyOmSync(client, plan);
  assert.equal(res.ok, false);
  assert.match(res.refused ?? '', /non-OS-namespace/);
  assert.equal(calls.length, 0, 'a tampered plan writes nothing');
});

test('provisioning is idempotent shells + refuses on a bad version', async () => {
  const applied: string[] = [];
  const put = async (path: string): Promise<OmWrite> => { applied.push(path); return { ok: true, data: {} }; };
  const good = await provisionOmNamespace(put, '1.5.0');
  assert.equal(good.ok, true);
  assert.equal(good.applied.length, omProvisionPlan().length, 'every shell step ran');

  const bad = await provisionOmNamespace(put, '9.9.9');
  assert.equal(bad.ok, false);
  assert.match(bad.refused ?? '', /outside tested write range/);
});
