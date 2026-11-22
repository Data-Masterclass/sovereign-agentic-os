/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Platform → Models: the catalog (LiteLLM's, read-only) and the role mapping (the OS's, editable).
 * USER STORY: As a platform admin I see each role's current model with its cost per token, I remap a
 *             role, and a mapping to a model that is not in the catalog is refused with a clear,
 *             typed error. Every change is audited. A role pointing at a removed model shows a warning.
 * ARCHITECTURE:
 *   - Admin gate, the LiteLLM catalog read and the file/gateway IO are mocked; the route, the
 *     validation and the reconcile are real.
 *   - NEGATIVE TWINS: a bad shape and a missing model change nothing and are not audited as applied.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

type Rows = { ok: true; data: unknown[] } | { ok: false; error: string };
let CATALOG: Rows = { ok: true, data: [] };
const real = async (m: string): Promise<Record<string, unknown>> => ({ ...(await import(m)) });
const row = (name: string, inCost = 0.000001, outCost = 0.000004) => ({ model_name: name, litellm_params: { model: 'openai/x' }, model_info: { id: `id-${name}`, db_model: true, input_cost_per_token: inCost, output_cost_per_token: outCost } });

const fake = { file: null as null | Record<string, string>, aliases: {} as Record<string, string>, commits: [] as string[], audits: [] as { action: string; target: string; actor: string }[] };
mock.module('@core/infra/litellm-admin', { namedExports: { ...(await real('@core/infra/litellm-admin')), readModels: async () => CATALOG, readCredentials: async () => ({ ok: true, data: [] }) } });
mock.module('@core/models/role-live', {
  namedExports: {
    liveRoleIo: () => ({
      readMapping: async () => fake.file,
      writeMapping: async (m: Record<string, string>, by: string) => { fake.file = m; fake.commits.push(by); return { sha: 'abc', changed: true }; },
      catalog: async () => (CATALOG.ok ? { ok: true, data: (CATALOG.data as { model_name: string }[]).map((r) => r.model_name) } : CATALOG),
      readAliases: async () => ({ ok: true, data: { ...fake.aliases } }),
      writeAliases: async (a: Record<string, string>) => { fake.aliases = { ...a }; return { ok: true, data: {} }; },
      audit: () => undefined,
      log: () => undefined,
    }),
  },
});
mock.module('../../../app/api/platform-admin/_ctx.ts', {
  namedExports: {
    adminCtx: async () => ({ user: { id: 'admin1', name: 'Ada Admin', role: 'admin' }, tenant: { id: 't1' }, opa: 'opa-allow' }),
    fail: (e: Error) => Response.json({ error: e.message }, { status: (e as { status?: number }).status ?? 500 }),
  },
});
mock.module('@tabs/admin/lib/audit', {
  namedExports: { audit: (e: { action: string; target: string; actor: string }) => { fake.audits.push(e); } },
});
mock.module('@core/infra/governed', { namedExports: { authorize: async () => ({ allowed: true, policy: 'opa-allow' }) } });

const route = await import('../../../app/api/platform-admin/models/roles/route.ts');
const put = (body: unknown) => route.PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }));
const ROLES = { 'sovereign-strong': 'big', 'sovereign-worker': 'small', 'sovereign-embedding': 'emb' };

beforeEach(() => {
  fake.file = null; fake.aliases = {}; fake.commits = []; fake.audits = [];
  CATALOG = { ok: true, data: [row('big', 0.000002, 0.000008), row('small'), row('emb', 0.0000001, 0), row('other')] };
});

test('PUT maps the roles, commits the file as the admin, enforces it at the gateway and audits it', async () => {
  const res = await put({ roles: ROLES });
  assert.equal(res.status, 200);
  assert.deepEqual(fake.file, ROLES);
  assert.deepEqual(fake.commits, ['admin1']);
  assert.equal(fake.aliases['sovereign-strong'], 'big');
  assert.deepEqual(fake.audits.map((a) => [a.action, a.target, a.actor]), [['models.roles.set', 'models:roles', 'admin1']]);
});

test('NEGATIVE TWIN: a mapping to a model that is not in the catalog is refused (422, typed) and changes nothing', async () => {
  const res = await put({ roles: { ...ROLES, 'sovereign-strong': 'ghost' } });
  assert.equal(res.status, 422);
  const b = (await res.json()) as { code: string; role: string; model: string; error: string };
  assert.deepEqual([b.code, b.role, b.model], ['unknown_catalog_model', 'sovereign-strong', 'ghost']);
  assert.match(b.error, /ghost/);
  assert.deepEqual([fake.file, fake.commits, fake.audits, fake.aliases], [null, [], [], {}]);
});

test('NEGATIVE TWIN: an unknown role or a malformed body is refused (422) and changes nothing', async () => {
  assert.equal((await put({ roles: { ...ROLES, 'sovereign-extra': 'big' } })).status, 422);
  assert.equal((await put({ nothing: true })).status, 422);
  assert.equal((await route.PUT(new Request('http://x', { method: 'PUT', body: 'not json' }))).status, 400);
  assert.deepEqual([fake.file, fake.commits, fake.audits], [null, [], []]);
});

test('GET: each role with its model and cost per 1M tokens, the read-only catalog, and the LiteLLM link', async () => {
  await put({ roles: ROLES });
  const b = (await (await route.GET()).json()) as { roles: { role: string; model: string; inCatalog: boolean; cost: { inputPerM: number; outputPerM: number } | null }[]; catalog: { name: string; cost: unknown }[]; litellmUi: string; ownedBy: Record<string, string>; warnings: string[] };
  const strong = b.roles.find((r) => r.role === 'sovereign-strong')!;
  assert.deepEqual([strong.model, strong.inCatalog, strong.cost], ['big', true, { inputPerM: 2, outputPerM: 8 }]);
  assert.equal(b.roles.find((r) => r.role === 'sovereign-embedding')!.cost!.inputPerM, 0.1);
  assert.deepEqual(b.catalog.map((c) => c.name).sort(), ['big', 'emb', 'other', 'small']);
  assert.match(b.litellmUi, /litellm/);
  assert.deepEqual(b.ownedBy, { catalog: 'LiteLLM', roles: 'OS' });
  assert.deepEqual(b.warnings, []);
});

test('GET: a catalog model removed under a role is a warning on that role — and the mapping is not changed', async () => {
  await put({ roles: ROLES });
  CATALOG = { ok: true, data: [row('small'), row('emb')] };
  const b = (await (await route.GET()).json()) as { roles: { role: string; model: string; inCatalog: boolean; cost: unknown }[]; warnings: string[] };
  const strong = b.roles.find((r) => r.role === 'sovereign-strong')!;
  assert.deepEqual([strong.model, strong.inCatalog, strong.cost], ['big', false, null]);
  assert.ok(b.warnings.some((w) => /sovereign-strong/.test(w) && /big/.test(w)));
  assert.deepEqual(fake.file, ROLES, 'no silent fallback');
});

test('GET with LiteLLM unreachable says so and lists no catalog (no stale list)', async () => {
  await put({ roles: ROLES });
  CATALOG = { ok: false, error: 'timeout' };
  const b = (await (await route.GET()).json()) as { catalog: unknown[]; source: string; error?: string };
  assert.deepEqual([b.catalog, b.source], [[], 'unavailable']);
  assert.match(String(b.error), /timeout/);
});
