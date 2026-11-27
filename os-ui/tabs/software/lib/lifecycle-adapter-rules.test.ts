/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (F) - the app lifecycle adapter's `canGoLive` asks the go-live rule table (flag on only)
 * USER STORY: As a creator I take my own app live in My scope without anyone; in Domain scope a domain admin of that
 *             domain (or an admin) takes it live, never me alone; in Company scope only an admin. An admin changes a
 *             rule in Platform and the next go-live follows it. With the App Builder off, nothing changes.
 * ARCHITECTURE: the real adapter and the real rule store (in-memory mirror seam); the app read is a stand-in.
 */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { GoLiveRulesMirror } from '@core/policy/go-live-rules-store';

type FakeApp = { id: string; name: string; owner: string; domain: string; visibility: 'Personal' | 'Shared' | 'Certified' };
const APPS = new Map<string, FakeApp>();
mock.module('@tabs/software/lib/apps', {
  namedExports: {
    getAppForUser: async (id: string) => {
      const a = APPS.get(id);
      if (!a) throw Object.assign(new Error('App not found'), { status: 404 });
      return a;
    },
    listAppsForUser: async () => [...APPS.values()],
  },
});
mock.module('@tabs/software/lib/releases/consequences', { namedExports: { releaseConsequences: async () => [] } });

const { appLifecycleAdapter } = await import('@tabs/software/lib/lifecycle-adapter');
const { __setGoLiveRulesMirror, setGoLiveRules } = await import('@core/policy/go-live-rules-store');

const DOCS = new Map<string, unknown>();
let REACHABLE = true;
const fake: GoLiveRulesMirror = {
  probe: async () => REACHABLE,
  read: async (id) => (!REACHABLE ? { state: 'unreachable' } : DOCS.has(id) ? { state: 'found', doc: structuredClone(DOCS.get(id)) } : { state: 'absent' }),
  writeConfirmed: async (id, doc) => { DOCS.set(id, structuredClone(doc)); return { ok: true }; },
};

const actor = (id: string, role: string, domains: string[] = ['sales']) => ({ id, role, domains });
const obj = (id: string) => ({ kind: 'app' as const, id, name: id, domain: 'sales', head: 'h', tier: 'x' });
const can = async (a: ReturnType<typeof actor>, id: string) => appLifecycleAdapter.canGoLive(a, obj(id));

beforeEach(() => {
  APPS.clear();
  DOCS.clear();
  REACHABLE = true;
  __setGoLiveRulesMirror(fake);
  APPS.set('mine', { id: 'mine', name: 'mine', owner: 'cora', domain: 'sales', visibility: 'Personal' });
  APPS.set('dom', { id: 'dom', name: 'dom', owner: 'cora', domain: 'sales', visibility: 'Shared' });
  APPS.set('co', { id: 'co', name: 'co', owner: 'cora', domain: 'sales', visibility: 'Certified' });
  APPS.set('dom-by-dan', { id: 'dom-by-dan', name: 'dom-by-dan', owner: 'dan', domain: 'sales', visibility: 'Shared' });
});
afterEach(() => {
  __setGoLiveRulesMirror(null);
  delete process.env.SOFTWARE_APP_BUILDER;
});

test('flag ON, defaults: My scope — the creator goes live alone; nobody else can', async () => {
  process.env.SOFTWARE_APP_BUILDER = 'on';
  assert.deepEqual(await can(actor('cora', 'creator'), 'mine'), { ok: true });
  assert.equal((await can(actor('ada', 'admin', []), 'mine')).ok, false, 'a Personal app is its owner’s alone');
});

test('flag ON, defaults: Domain scope — a domain admin of THAT domain or an admin; never the owner alone', async () => {
  process.env.SOFTWARE_APP_BUILDER = 'on';
  const own = await can(actor('cora', 'creator'), 'dom');
  assert.equal(own.ok, false);
  assert.match((own as { reason: string }).reason, /nobody approves their own go-live/);
  assert.deepEqual(await can(actor('dan', 'domain_admin'), 'dom'), { ok: true });
  assert.deepEqual(await can(actor('ada', 'admin', []), 'dom'), { ok: true }, 'admin satisfies a domain_admin row in any domain');
  assert.equal((await can(actor('bob', 'builder'), 'dom')).ok, false, 'a builder is below the row');
  assert.equal((await can(actor('eve', 'domain_admin', ['hr']), 'dom')).ok, false, 'another domain’s admin is refused');
});

test('flag ON: a domain admin who owns the app cannot take it to Domain alone (self-approval)', async () => {
  process.env.SOFTWARE_APP_BUILDER = 'on';
  const r = await can(actor('dan', 'domain_admin'), 'dom-by-dan');
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /nobody approves their own go-live/);
  assert.deepEqual(await can(actor('ada', 'admin', []), 'dom-by-dan'), { ok: true });
});

test('flag ON, defaults: Company scope — admin only', async () => {
  process.env.SOFTWARE_APP_BUILDER = 'on';
  assert.equal((await can(actor('dan', 'domain_admin'), 'co')).ok, false);
  assert.deepEqual(await can(actor('ada', 'admin', []), 'co'), { ok: true });
  assert.equal((await can(actor('cora', 'creator'), 'co')).ok, false);
});

test('flag ON: an admin changes the Domain rule to builder and the next go-live follows it', async () => {
  process.env.SOFTWARE_APP_BUILDER = 'on';
  assert.equal((await can(actor('bob', 'builder'), 'dom')).ok, false);
  await setGoLiveRules({ rules: [{ kind: 'app', scope: 'domain', reviewer: 'builder' }], actor: { id: 'ada', role: 'admin' }, via: 'ui' });
  assert.deepEqual(await can(actor('bob', 'builder'), 'dom'), { ok: true });
  assert.equal((await can(actor('cora', 'creator'), 'dom')).ok, false, 'still never the owner alone');
  // Domain → none: the owner (an editor) goes live alone; a stranger still cannot.
  await setGoLiveRules({ rules: [{ kind: 'app', scope: 'domain', reviewer: 'none' }], actor: { id: 'ada', role: 'admin' }, via: 'ui' });
  assert.deepEqual(await can(actor('cora', 'creator'), 'dom'), { ok: true });
  assert.equal((await can(actor('bob', 'builder'), 'dom')).ok, false, '`none` still needs someone who may edit the app');
});

test('flag ON: an unreadable rule store fails closed — even My scope needs an admin', async () => {
  process.env.SOFTWARE_APP_BUILDER = 'on';
  REACHABLE = false;
  assert.equal((await can(actor('cora', 'creator'), 'mine')).ok, false);
});

test('flag OFF: exactly the check before App Builder (owner, or in-domain domain admin for non-Personal)', async () => {
  delete process.env.SOFTWARE_APP_BUILDER;
  REACHABLE = false; // the rule store is never consulted with the flag off
  assert.deepEqual(await can(actor('cora', 'creator'), 'dom'), { ok: true }, 'the owner alone, as before');
  assert.deepEqual(await can(actor('cora', 'creator'), 'co'), { ok: true });
  assert.deepEqual(await can(actor('dan', 'domain_admin'), 'dom'), { ok: true });
  assert.equal((await can(actor('ada', 'admin', []), 'dom')).ok, false, 'an out-of-domain admin was refused before, and still is');
  assert.equal((await can(actor('bob', 'builder'), 'dom')).ok, false);
});
