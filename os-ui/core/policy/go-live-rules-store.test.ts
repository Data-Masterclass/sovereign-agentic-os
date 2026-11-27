/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel policy
 * FEATURE:    App Builder (F) - the sealed go-live rule store: defaults, validation, admin-only write, audit, fail closed
 * USER STORY: As an admin I change who reviews a go-live and the change holds, is audited with old and new, and
 *             cannot be forged in the index; as anyone going live, a broken or unreadable table means an admin reviews.
 * ARCHITECTURE: the real store over an in-memory mirror (the `__setGoLiveRulesMirror` seam) and the real audit module.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __setGoLiveRulesMirror,
  failClosedRules,
  readGoLiveRules,
  setGoLiveRules,
  validateGoLiveRules,
  type GoLiveRulesMirror,
} from '@core/policy/go-live-rules-store';
import { DEFAULT_GO_LIVE_RULES, canReview, currentGoLiveRules } from '@core/policy/go-live-rules';
import { search } from '@core/policy/audit';

const DOCS = new Map<string, unknown>();
let REACHABLE = true;
let WRITE_OK = true;
const fake: GoLiveRulesMirror = {
  probe: async () => REACHABLE,
  read: async (id) => (!REACHABLE ? { state: 'unreachable' } : DOCS.has(id) ? { state: 'found', doc: structuredClone(DOCS.get(id)) } : { state: 'absent' }),
  writeConfirmed: async (id, doc) => {
    if (!WRITE_OK) return { ok: false, reason: 'HTTP 503' };
    DOCS.set(id, structuredClone(doc));
    return { ok: true };
  },
};

const ADMIN = { id: 'ada', role: 'admin' };

beforeEach(() => {
  DOCS.clear();
  REACHABLE = true;
  WRITE_OK = true;
  __setGoLiveRulesMirror(fake);
});
afterEach(() => __setGoLiveRulesMirror(null));

test('nothing saved ⇒ the owner defaults: My none, Domain domain_admin, Company admin (app and agent)', async () => {
  const s = await readGoLiveRules();
  assert.equal(s.integrity, 'default');
  assert.equal(s.version, 0);
  assert.deepEqual(s.rules, [...DEFAULT_GO_LIVE_RULES]);
  const app = (scope: string) => s.rules.find((r) => r.kind === 'app' && r.scope === scope)?.reviewer;
  assert.deepEqual([app('my'), app('domain'), app('company')], ['none', 'domain_admin', 'admin']);
});

test('an admin saves a rule: merged onto the table, sealed, versioned, read back by every decision', async () => {
  const saved = await setGoLiveRules({ rules: [{ kind: 'app', scope: 'domain', reviewer: 'builder' }], actor: ADMIN, via: 'ui' });
  assert.equal(saved.version, 1);
  assert.equal(saved.rules.length, 6, 'the result is always the complete table');
  assert.equal(saved.rules.find((r) => r.kind === 'app' && r.scope === 'domain')?.reviewer, 'builder');
  assert.equal(saved.rules.find((r) => r.kind === 'app' && r.scope === 'company')?.reviewer, 'admin', 'other rows unchanged');
  const read = await readGoLiveRules();
  assert.equal(read.integrity, 'sealed');
  assert.equal(read.updatedBy, 'ada');
  assert.deepEqual(read.rules, saved.rules);
  assert.deepEqual(await currentGoLiveRules(), saved.rules, 'currentGoLiveRules reads the store');
});

test('every change is audited with the old and the new table', async () => {
  await setGoLiveRules({ rules: [{ kind: 'app', scope: 'my', reviewer: 'builder' }], actor: ADMIN, via: 'mcp', opa: { decisionId: 'dec-1' } });
  const row = search({ q: 'go-live rules v1' })[0];
  assert.ok(row, 'an audit row was written');
  assert.equal(row.action, 'policy.override');
  assert.equal(row.subject, 'go-live-rules');
  assert.equal(row.actor, 'ada');
  assert.equal(row.decisionId, 'dec-1');
  assert.match(row.reason, /app\/my: none → builder/);
  const old = row.detail.old as { kind: string; scope: string; reviewer: string }[];
  const neu = row.detail.new as { kind: string; scope: string; reviewer: string }[];
  assert.equal(old.find((r) => r.kind === 'app' && r.scope === 'my')?.reviewer, 'none');
  assert.equal(neu.find((r) => r.kind === 'app' && r.scope === 'my')?.reviewer, 'builder');
  assert.equal(row.detail.via, 'mcp');
});

test('only an admin can write (the store re-checks whatever the door did)', async () => {
  for (const role of ['creator', 'builder', 'domain_admin']) {
    await assert.rejects(
      setGoLiveRules({ rules: [{ kind: 'app', scope: 'my', reviewer: 'none' }], actor: { id: 'x', role }, via: 'ui' }),
      (e: Error & { status?: number }) => e.status === 403,
    );
  }
  assert.equal(DOCS.size, 0, 'nothing written');
});

test('self-approval is not configurable: any field beyond { kind, scope, reviewer } is refused', () => {
  for (const extra of [{ selfApproval: true }, { allowSelfApproval: true }, { requesterMayApprove: true }]) {
    const v = validateGoLiveRules([{ kind: 'app', scope: 'domain', reviewer: 'domain_admin', ...extra }]);
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /not configurable/);
  }
});

test('validation: closed sets for kind, scope and reviewer; no duplicates; not empty', () => {
  assert.equal(validateGoLiveRules([{ kind: 'app', scope: 'domain', reviewer: 'owner' }]).ok, false, 'reviewer outside the closed role set');
  assert.equal(validateGoLiveRules([{ kind: 'app', scope: 'domain', reviewer: 'creator' }]).ok, false, 'creator is not a reviewer');
  assert.equal(validateGoLiveRules([{ kind: 'dashboard', scope: 'my', reviewer: 'none' }]).ok, false);
  assert.equal(validateGoLiveRules([{ kind: 'app', scope: 'tenant', reviewer: 'none' }]).ok, false);
  assert.equal(validateGoLiveRules([]).ok, false);
  assert.equal(validateGoLiveRules('admin').ok, false);
  assert.equal(validateGoLiveRules([{ kind: 'app', scope: 'my', reviewer: 'none' }, { kind: 'app', scope: 'my', reviewer: 'admin' }]).ok, false);
});

test('an invalid write changes nothing and is not audited', async () => {
  await assert.rejects(
    setGoLiveRules({ rules: [{ kind: 'app', scope: 'my', reviewer: 'none', selfApproval: true }], actor: ADMIN, via: 'ui' }),
    (e: Error & { status?: number }) => e.status === 400,
  );
  assert.equal(DOCS.size, 0);
  assert.equal((await readGoLiveRules()).integrity, 'default');
});

test('the store did not confirm the write ⇒ 503 and nothing changes', async () => {
  WRITE_OK = false;
  await assert.rejects(
    setGoLiveRules({ rules: [{ kind: 'app', scope: 'my', reviewer: 'admin' }], actor: ADMIN, via: 'ui' }),
    (e: Error & { status?: number }) => e.status === 503,
  );
  assert.equal((await readGoLiveRules()).integrity, 'default');
});

test('optimistic version: a stale editor gets 409', async () => {
  await setGoLiveRules({ rules: [{ kind: 'app', scope: 'my', reviewer: 'builder' }], actor: ADMIN, via: 'ui', expectedVersion: 0 });
  await assert.rejects(
    setGoLiveRules({ rules: [{ kind: 'app', scope: 'my', reviewer: 'none' }], actor: ADMIN, via: 'ui', expectedVersion: 0 }),
    (e: Error & { status?: number }) => e.status === 409,
  );
});

test('integrity: a table changed in the index without the seal fails closed to admin on every row', async () => {
  await setGoLiveRules({ rules: [{ kind: 'app', scope: 'company', reviewer: 'admin' }], actor: ADMIN, via: 'ui' });
  const doc = DOCS.get('table') as { rules: { kind: string; scope: string; reviewer: string }[] };
  doc.rules = doc.rules.map((r) => ({ ...r, reviewer: 'none' })); // forged: nobody reviews anything
  DOCS.set('table', doc);
  const s = await readGoLiveRules();
  assert.equal(s.integrity, 'broken');
  assert.deepEqual(s.rules, failClosedRules());
  assert.match(s.reason ?? '', /seal/);
  // An admin re-saves: sealed again, merged onto the defaults (not onto the all-admin view).
  const fixed = await setGoLiveRules({ rules: [{ kind: 'app', scope: 'domain', reviewer: 'domain_admin' }], actor: ADMIN, via: 'ui' });
  assert.equal(fixed.rules.find((r) => r.kind === 'app' && r.scope === 'my')?.reviewer, 'none');
  assert.equal((await readGoLiveRules()).integrity, 'sealed');
});

test('integrity: a sealed document with an invalid row (or no seal) is refused too', async () => {
  DOCS.set('table', { id: 'table', v: 1, version: 3, rules: [{ kind: 'app', scope: 'my', reviewer: 'none', selfApproval: true }], updatedAt: 'x', updatedBy: 'y', seal: 'nope' });
  assert.equal((await readGoLiveRules()).integrity, 'broken');
  DOCS.set('table', { foo: 1 });
  assert.equal((await readGoLiveRules()).integrity, 'broken');
});

test('an unreachable store fails closed (admin everywhere) and refuses writes with 503', async () => {
  REACHABLE = false;
  const s = await readGoLiveRules();
  assert.equal(s.integrity, 'unreachable');
  assert.ok(s.rules.every((r) => r.reviewer === 'admin'));
  await assert.rejects(
    setGoLiveRules({ rules: [{ kind: 'app', scope: 'my', reviewer: 'none' }], actor: ADMIN, via: 'ui' }),
    (e: Error & { status?: number }) => e.status === 503,
  );
});

test('the stored table feeds canReview: admin satisfies domain_admin, the requester never reviews', async () => {
  const rules = await currentGoLiveRules();
  const req = { kind: 'app' as const, scope: 'domain' as const, domain: 'sales', requestedBy: 'dora' };
  assert.deepEqual(canReview(rules, req, { id: 'ada', role: 'admin', domains: [] }), { ok: true });
  assert.deepEqual(canReview(rules, req, { id: 'dan', role: 'domain_admin', domains: ['sales'] }), { ok: true });
  assert.equal(canReview(rules, req, { id: 'dora', role: 'domain_admin', domains: ['sales'] }).ok, false);
  assert.equal(canReview(rules, req, { id: 'bob', role: 'builder', domains: ['sales'] }).ok, false);
});
