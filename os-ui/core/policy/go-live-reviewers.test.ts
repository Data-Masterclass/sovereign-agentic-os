/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel policy
 * FEATURE:    App Builder (H) - the "no other eligible reviewer" notice over the installed user directory
 * USER STORY: As an app builder I want to be told when nobody but me could approve my go-live, and to be told
 *             "could not check" (never "all clear") when the directory cannot be read.
 * ARCHITECTURE: the pure rule table (DEFAULT_GO_LIVE_RULES) and a stub directory installed through the port.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GO_LIVE_RULES, type GoLiveRequest } from '@core/policy/go-live-rules';
import { goLiveReviewerNotice, registerGoLiveCandidates } from '@core/policy/go-live-reviewers';

afterEach(() => registerGoLiveCandidates(null));

const domainReq: GoLiveRequest = { kind: 'app', scope: 'domain', domain: 'sales', requestedBy: 'dora' };

test('no directory installed: not checked, with the reason; never an all-clear', async () => {
  const r = await goLiveReviewerNotice(DEFAULT_GO_LIVE_RULES, domainReq);
  assert.equal(r.checked, false);
  assert.equal(r.notice, null);
  assert.match(r.checked ? '' : r.reason, /directory/);
});

test('a directory that throws: not checked, the error named', async () => {
  registerGoLiveCandidates(async () => {
    throw new Error('mirror offline');
  });
  const r = await goLiveReviewerNotice(DEFAULT_GO_LIVE_RULES, domainReq);
  assert.equal(r.checked, false);
  assert.match(r.checked ? '' : r.reason, /mirror offline/);
});

test('Domain scope: the requester is the only domain admin and there is no admin ⇒ the notice', async () => {
  registerGoLiveCandidates(async () => [
    { id: 'dora', role: 'domain_admin', domains: ['sales'] },
    { id: 'bob', role: 'builder', domains: ['sales'] },
    { id: 'hana', role: 'domain_admin', domains: ['hr'] },
  ]);
  const r = await goLiveReviewerNotice(DEFAULT_GO_LIVE_RULES, domainReq);
  assert.deepEqual(r, { checked: true, notice: 'no other eligible reviewer; an admin can change the rule' });
});

test('a deactivated admin is no reviewer; an active one is', async () => {
  registerGoLiveCandidates(async () => [
    { id: 'dora', role: 'domain_admin', domains: ['sales'] },
    { id: 'ada', role: 'admin', domains: [], disabled: true },
  ]);
  assert.notEqual((await goLiveReviewerNotice(DEFAULT_GO_LIVE_RULES, domainReq)).notice, null);
  registerGoLiveCandidates(async () => [
    { id: 'dora', role: 'domain_admin', domains: ['sales'] },
    { id: 'ada', role: 'admin', domains: [] },
  ]);
  assert.deepEqual(await goLiveReviewerNotice(DEFAULT_GO_LIVE_RULES, domainReq), { checked: true, notice: null });
});

test('My scope needs no reviewer: no notice even with nobody else', async () => {
  registerGoLiveCandidates(async () => [{ id: 'dora', role: 'creator', domains: ['sales'] }]);
  assert.deepEqual(await goLiveReviewerNotice(DEFAULT_GO_LIVE_RULES, { ...domainReq, scope: 'my' }), { checked: true, notice: null });
});

test('Company scope: only an admin who is not the requester counts', async () => {
  registerGoLiveCandidates(async () => [
    { id: 'ada', role: 'admin', domains: [] },
    { id: 'dora', role: 'domain_admin', domains: ['sales'] },
  ]);
  const company: GoLiveRequest = { ...domainReq, scope: 'company', requestedBy: 'ada' };
  assert.notEqual((await goLiveReviewerNotice(DEFAULT_GO_LIVE_RULES, company)).notice, null);
});
