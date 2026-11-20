/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Unit pins for the OPA state reconciler's refusal and status rules.
 * USER STORY: As an operator I want a failed grant contributor to block the whole-document grants
 *             write, and an unreachable OPA to report "not restored" — never a silent success.
 * ARCHITECTURE:
 *   - No OPA here (OPA_URL points at a closed port); the restore against the real OPA 1.22.4 image
 *     is `tests/opa/state-reconcile.int.test.ts`.
 */
process.env.OPA_URL = 'http://127.0.0.1:9'; // nothing listens: every OPA call is unreachable
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetOpaReconcile,
  opaReconcileStatus,
  publishGrantsDocument,
  reconcileOpaState,
  registerGrantContributor,
  registerOpaStateSource,
} from '@core/policy/opa-reconcile';

beforeEach(() => __resetOpaReconcile());

test('a failing grant contributor refuses the whole-document grants write', async () => {
  registerGrantContributor({ name: 'agents', grants: async () => { throw new Error('store down'); } });
  const r = await publishGrantsDocument({ 'domain:x': ['query'] });
  assert.equal(r.ok, false);
  assert.match(r.detail, /contributor "agents" failed — store down/);
});

test('an unreachable OPA is "not-restored", never restored', async () => {
  let ran = false;
  registerOpaStateSource({ name: 'grants', restore: async () => { ran = true; return { ok: true, detail: '' }; } });
  const st = await reconcileOpaState('test');
  assert.equal(st.state, 'not-restored');
  assert.match(st.detail, /unreachable/);
  assert.equal(ran, false, 'no source runs against an unreachable OPA');
  assert.equal(opaReconcileStatus().state, 'not-restored');
});

test('no registered sources is "not-restored"', async () => {
  const st = await reconcileOpaState('test');
  assert.equal(st.state, 'not-restored');
  assert.match(st.detail, /no policy-state sources/);
});
