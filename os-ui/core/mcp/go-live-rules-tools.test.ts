/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       mcp
 * FEATURE:    App Builder (F) - MCP `get_go_live_rules` / `set_go_live_rules`
 * USER STORY: As an admin in my own MCP session I read and change the go-live rule table, checked by OPA and audited;
 *             a non-admin cannot change it, a self-approval field is refused, and while the App Builder is off both
 *             tools answer `app_builder_disabled` without reading anything.
 * ARCHITECTURE: the real tools and the real store (in-memory mirror seam); OPA is a stand-in.
 */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import type { GoLiveRulesMirror } from '@core/policy/go-live-rules-store';

let OPA: 'opa-allow' | 'opa-deny' = 'opa-allow';
const OPA_CALLS: string[] = [];
const realGoverned = await import('@core/infra/governed');
mock.module('@core/infra/governed', {
  namedExports: {
    ...realGoverned,
    authorize: async (principal: string, tool: string) => {
      OPA_CALLS.push(`${principal}:${tool}`);
      return { allowed: OPA === 'opa-allow', policy: OPA, decisionId: 'dec-42' };
    },
  },
});

const { governanceTools } = await import('@core/mcp/governance-tools');
const { __setGoLiveRulesMirror } = await import('@core/policy/go-live-rules-store');
const { search } = await import('@core/policy/audit');

const DOCS = new Map<string, unknown>();
let READS = 0;
const fake: GoLiveRulesMirror = {
  probe: async () => true,
  read: async (id) => { READS++; return DOCS.has(id) ? { state: 'found', doc: structuredClone(DOCS.get(id)) } : { state: 'absent' }; },
  writeConfirmed: async (id, doc) => { DOCS.set(id, structuredClone(doc)); return { ok: true }; },
};

const tool = (name: string) => {
  const t = governanceTools.find((x) => x.name === name);
  assert.ok(t, `${name} is registered`);
  return t!;
};
const user = (id: string, role: string) => ({ id, name: id, role, domains: ['sales'], allDomains: ['sales'] }) as unknown as CurrentUser;
const ADMIN = user('ada', 'admin');

beforeEach(() => {
  DOCS.clear();
  READS = 0;
  OPA = 'opa-allow';
  OPA_CALLS.length = 0;
  __setGoLiveRulesMirror(fake);
  process.env.SOFTWARE_APP_BUILDER = 'on';
});
afterEach(() => {
  __setGoLiveRulesMirror(null);
  delete process.env.SOFTWARE_APP_BUILDER;
});

test('registered as governance tools: get for every role, set for admins only', () => {
  assert.equal(tool('get_go_live_rules').minRole, 'creator');
  assert.equal(tool('set_go_live_rules').minRole, 'admin');
  assert.equal(tool('set_go_live_rules').tab, 'governance');
});

test('flag OFF: both tools answer app_builder_disabled before reading or writing anything', async () => {
  delete process.env.SOFTWARE_APP_BUILDER;
  for (const name of ['get_go_live_rules', 'set_go_live_rules']) {
    await assert.rejects(
      tool(name).call(ADMIN, { rules: [{ kind: 'app', scope: 'my', reviewer: 'admin' }] }),
      (e: Error & { code?: string; status?: number }) => e.code === 'app_builder_disabled' && e.status === 403,
    );
  }
  assert.equal(READS, 0);
  assert.equal(DOCS.size, 0);
  assert.equal(OPA_CALLS.length, 0);
});

test('get_go_live_rules: the defaults, the closed sets, and "never" for self-approval', async () => {
  const r = (await tool('get_go_live_rules').call(user('cora', 'creator'), {})) as {
    rules: { kind: string; scope: string; reviewer: string }[]; integrity: string; reviewers: string[]; selfApproval: string;
  };
  assert.equal(r.integrity, 'default');
  assert.equal(r.rules.find((x) => x.kind === 'app' && x.scope === 'domain')?.reviewer, 'domain_admin');
  assert.deepEqual(r.reviewers, ['none', 'builder', 'domain_admin', 'admin']);
  assert.match(r.selfApproval, /never/);
});

test('set_go_live_rules: an admin changes a row; OPA asked; sealed; audited with old and new and the OPA decision', async () => {
  const r = (await tool('set_go_live_rules').call(ADMIN, { rules: [{ kind: 'app', scope: 'company', reviewer: 'domain_admin' }], expectedVersion: 0 })) as {
    version: number; rules: { kind: string; scope: string; reviewer: string }[];
  };
  assert.equal(r.version, 1);
  assert.equal(r.rules.find((x) => x.kind === 'app' && x.scope === 'company')?.reviewer, 'domain_admin');
  assert.deepEqual(OPA_CALLS, ['user:ada:admin']);
  const row = search({ q: 'app/company: admin → domain_admin' })[0];
  assert.ok(row, 'audited');
  assert.equal(row.decisionId, 'dec-42');
  assert.equal(row.detail.via, 'mcp');
  const read = (await tool('get_go_live_rules').call(ADMIN, {})) as { integrity: string; version: number };
  assert.deepEqual([read.integrity, read.version], ['sealed', 1]);
});

test('set_go_live_rules: a non-admin is refused even when the dispatcher floor is bypassed', async () => {
  for (const role of ['creator', 'builder', 'domain_admin']) {
    await assert.rejects(
      tool('set_go_live_rules').call(user('x', role), { rules: [{ kind: 'app', scope: 'my', reviewer: 'none' }] }),
      (e: Error & { status?: number }) => e.status === 403,
    );
  }
  assert.equal(DOCS.size, 0);
});

test('set_go_live_rules: OPA deny refuses before anything is written', async () => {
  OPA = 'opa-deny';
  await assert.rejects(
    tool('set_go_live_rules').call(ADMIN, { rules: [{ kind: 'app', scope: 'my', reviewer: 'admin' }] }),
    (e: Error & { status?: number }) => e.status === 403 && /OPA/.test(e.message),
  );
  assert.equal(DOCS.size, 0);
});

test('set_go_live_rules: a self-approval field or a role outside the closed set is a bad request', async () => {
  await assert.rejects(
    tool('set_go_live_rules').call(ADMIN, { rules: [{ kind: 'app', scope: 'domain', reviewer: 'domain_admin', selfApproval: true }] }),
    (e: Error & { status?: number }) => e.status === 400 && /not configurable/.test(e.message),
  );
  await assert.rejects(
    tool('set_go_live_rules').call(ADMIN, { rules: [{ kind: 'app', scope: 'domain', reviewer: 'owner' }] }),
    (e: Error & { status?: number }) => e.status === 400,
  );
  assert.equal(DOCS.size, 0);
});

test('set_go_live_rules: a stale expectedVersion is a conflict', async () => {
  await tool('set_go_live_rules').call(ADMIN, { rules: [{ kind: 'app', scope: 'my', reviewer: 'builder' }] });
  await assert.rejects(
    tool('set_go_live_rules').call(ADMIN, { rules: [{ kind: 'app', scope: 'my', reviewer: 'none' }], expectedVersion: 0 }),
    (e: Error & { status?: number }) => e.status === 409,
  );
});
