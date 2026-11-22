/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / models
 * FEATURE:    The OS owns the role mapping and enforces it at LiteLLM; it repairs a foreign edit and says so.
 * USER STORY: As a platform admin I remap `sovereign-strong` in Platform → Models and every caller
 *             resolves it at the gateway at once. If someone edits the alias in LiteLLM directly, the
 *             OS puts it back and reports the drift. A catalog model removed under a role is a red
 *             warning, never a silent fallback.
 * ARCHITECTURE:
 *   - Injected IO (the file store, the catalog, the gateway's alias map); the real LiteLLM and a
 *     real git repository are proven in `tabs/admin/lib/model-roles.e2e.test.ts`.
 *   - NEGATIVE TWINS: no mapping = nothing written; unreadable gateway = "could not check", never
 *     "in sync"; a role at a missing model leaves its alias alone and is reported.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRoleMapping, lastRoleReport, reconcileRoleMapping, type RoleReconcileIo } from '@core/models/role-reconcile';
import { ModelMappingError, type RoleMapping } from '@core/models/role-mapping';

const MAP: RoleMapping = { 'sovereign-strong': 'big', 'sovereign-worker': 'small', 'sovereign-embedding': 'emb' };
function io(over: Partial<RoleReconcileIo> & { aliases?: Record<string, string>; catalog?: string[]; file?: RoleMapping | null } = {}) {
  const state = { aliases: { ...(over.aliases ?? {}) }, file: over.file === undefined ? MAP : over.file, writes: [] as Record<string, string>[], commits: [] as { m: RoleMapping; by: string }[], audits: [] as { action: string; detail?: unknown }[] };
  const r: RoleReconcileIo = {
    readMapping: async () => state.file,
    writeMapping: async (m, by) => { state.file = m; state.commits.push({ m, by }); return { sha: 'abc', changed: true }; },
    catalog: async () => ({ ok: true, data: over.catalog ?? ['big', 'small', 'emb', 'other'] }),
    readAliases: async () => ({ ok: true, data: { ...state.aliases } }),
    writeAliases: async (a) => { state.writes.push(a); state.aliases = { ...a }; return { ok: true, data: {} }; },
    audit: ((e: { action: string; detail?: unknown }) => { state.audits.push(e); }) as never,
    log: () => undefined,
    now: () => 1000,
    ...over,
  };
  return { r, state };
}

test('first apply writes the three roles and the deprecated names; a second pass writes nothing', async () => {
  const { r, state } = io();
  const rep = await reconcileRoleMapping(r);
  assert.equal(rep.state, 'applied');
  assert.equal(state.aliases['sovereign-strong'], 'big');
  assert.equal(state.aliases['sovereign-default'], 'small');
  assert.equal(state.aliases['sovereign-embed'], 'emb');
  assert.deepEqual(rep.drift, [], 'creating an alias that was absent is not drift');
  const again = await reconcileRoleMapping(r);
  assert.equal(again.state, 'in-sync');
  assert.equal(state.writes.length, 1);
});

test('a FOREIGN edit of an alias in LiteLLM is repaired AND reported (and audited)', async () => {
  const { r, state } = io();
  await reconcileRoleMapping(r);
  state.aliases['sovereign-strong'] = 'other';
  state.aliases['somebody-elses-alias'] = 'other';
  const rep = await reconcileRoleMapping(r);
  assert.equal(rep.state, 'repaired');
  assert.deepEqual(rep.drift.map((d) => [d.alias, d.have, d.want]), [['sovereign-strong', 'other', 'big']]);
  assert.equal(state.aliases['sovereign-strong'], 'big');
  assert.equal(state.aliases['somebody-elses-alias'], 'other', 'aliases the OS does not own are left alone');
  assert.ok(state.audits.some((a) => a.action === 'gateway.models.reconcile'));
});

test('NEGATIVE TWIN: no mapping file = nothing is written (the OS invents no model names)', async () => {
  const { r, state } = io({ file: null });
  const rep = await reconcileRoleMapping(r);
  assert.equal(rep.state, 'unmapped');
  assert.equal(state.writes.length, 0);
});

test('a catalog model removed while a role points at it: red warning, the alias is NOT silently changed', async () => {
  const { r, state } = io();
  await reconcileRoleMapping(r);
  const down = io({ aliases: state.aliases, catalog: ['small', 'emb'] });
  const rep = await reconcileRoleMapping(down.r);
  assert.equal(rep.state, 'blocked');
  assert.deepEqual(rep.missing, [{ role: 'sovereign-strong', model: 'big' }]);
  assert.equal(down.state.writes.length, 0);
  assert.equal(down.state.aliases['sovereign-strong'], 'big', 'no silent fallback to another model');
  assert.equal(rep.roles.find((x) => x.role === 'sovereign-strong')!.inCatalog, false);
});

test('NEGATIVE TWIN: an unreadable gateway is "could not check", never "in sync"', async () => {
  const { r } = io({ readAliases: async () => ({ ok: false, error: 'timeout' }) });
  const rep = await reconcileRoleMapping(r);
  assert.deepEqual([rep.ok, rep.state], [false, 'unreadable']);
  const c = io({ catalog: undefined });
  c.r.catalog = async () => ({ ok: false, error: 'HTTP 500' });
  assert.equal((await reconcileRoleMapping(c.r)).state, 'unreadable');
});

test('applyRoleMapping: validates against the catalog first (typed refusal, nothing committed or written)', async () => {
  const { r, state } = io({ file: null });
  await assert.rejects(
    applyRoleMapping(r, { ...MAP, 'sovereign-strong': 'ghost' }, 'admin1'),
    (e: unknown) => e instanceof ModelMappingError && e.code === 'unknown_catalog_model' && e.model === 'ghost',
  );
  assert.equal(state.commits.length, 0);
  assert.equal(state.writes.length, 0);
});

test('applyRoleMapping: commits the file as the admin, then enforces it at the gateway', async () => {
  const { r, state } = io({ file: null });
  const rep = await applyRoleMapping(r, { ...MAP, 'sovereign-strong': 'other' }, 'admin1');
  assert.deepEqual(state.commits.map((c) => c.by), ['admin1']);
  assert.equal(state.aliases['sovereign-strong'], 'other');
  assert.equal(rep.state, 'applied');
  assert.equal(lastRoleReport()?.state, 'applied');
});

test('NEGATIVE TWIN: if the gateway refuses the write the report says so (not applied, not in sync)', async () => {
  const { r } = io({ writeAliases: async () => ({ ok: false, error: 'HTTP 400: set in the config file' }) });
  const rep = await reconcileRoleMapping(r);
  assert.deepEqual([rep.ok, rep.state], [false, 'unreadable']);
  assert.match(String(rep.error), /config file/);
});
