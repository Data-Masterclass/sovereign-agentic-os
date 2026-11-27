/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel policy
 * FEATURE:    App Builder (W0) - the go-live rule table: defaults, who may review, never self-approval
 * USER STORY: As an admin I want My go-lives to need no review, Domain go-lives a domain admin of that domain (or
 *             higher), Company go-lives an admin, and nobody ever approving their own go-live.
 * ARCHITECTURE: Pure table tests over go-live-rules.ts. Negative twins for every positive: lower role, other domain,
 *             the requester, a missing row (fails closed to admin).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GO_LIVE_RULES,
  canReview,
  currentGoLiveRules,
  goLiveDecision,
  noEligibleReviewer,
  scopeOfVisibility,
  type GoLiveRequest,
  type GoLiveRule,
  type GoLiveUser,
} from './go-live-rules.ts';

const R = DEFAULT_GO_LIVE_RULES;
const u = (id: string, role: GoLiveUser['role'], domains: string[] = ['sales']): GoLiveUser => ({ id, role, domains });
const req = (scope: GoLiveRequest['scope'], requestedBy = 'carol', domain = 'sales'): GoLiveRequest => ({ kind: 'app', scope, domain, requestedBy });

test('defaults: app my → none, domain → domain_admin, company → admin; agent rows exist', () => {
  const r = (kind: 'app' | 'agent', scope: GoLiveRequest['scope']) => R.find((x) => x.kind === kind && x.scope === scope)?.reviewer;
  assert.deepEqual([r('app', 'my'), r('app', 'domain'), r('app', 'company')], ['none', 'domain_admin', 'admin']);
  assert.deepEqual([r('agent', 'my'), r('agent', 'domain'), r('agent', 'company')], ['none', 'domain_admin', 'admin']);
  assert.ok(Object.isFrozen(R));
});

test('goLiveDecision: My auto-approves (gates still apply), Domain and Company need a review', () => {
  assert.equal(goLiveDecision(R, 'app', 'my', 'sales').autoApprove, true);
  assert.equal(goLiveDecision(R, 'app', 'domain', 'sales').reviewer, 'domain_admin');
  assert.equal(goLiveDecision(R, 'app', 'domain', 'sales').autoApprove, false);
  assert.match(goLiveDecision(R, 'app', 'domain', 'sales').reason, /domain 'sales'/);
  assert.equal(goLiveDecision(R, 'app', 'company', 'sales').reviewer, 'admin');
});

test('a missing row fails CLOSED to an admin review', () => {
  const only: GoLiveRule[] = [{ kind: 'app', scope: 'my', reviewer: 'none' }];
  const d = goLiveDecision(only, 'app', 'domain', 'sales');
  assert.equal(d.reviewer, 'admin');
  assert.match(d.reason, /no rule is configured/);
  assert.equal(canReview(only, req('domain'), u('dora', 'domain_admin')).ok, false);
  assert.equal(canReview(only, req('domain'), u('ada', 'admin', [])).ok, true);
});

test('My scope: no review — nobody "reviews", not even an admin (there is nothing to approve)', () => {
  assert.equal(canReview(R, req('my'), u('ada', 'admin')).ok, false);
  assert.equal(noEligibleReviewer(R, req('my'), []), null);
});

test('Domain scope: a domain_admin of THAT domain, or higher; a builder, another domain\'s admin and the requester may not', () => {
  assert.equal(canReview(R, req('domain'), u('dora', 'domain_admin')).ok, true);
  assert.equal(canReview(R, req('domain'), u('ada', 'admin', [])).ok, true, 'admin satisfies a domain_admin row in any domain');
  assert.equal(canReview(R, req('domain'), u('bob', 'builder')).ok, false);
  assert.equal(canReview(R, req('domain'), u('cris', 'creator')).ok, false);
  const other = canReview(R, req('domain'), u('dan', 'domain_admin', ['finance']));
  assert.equal(other.ok, false);
  assert.match((other as { reason: string }).reason, /not a member of domain 'sales'/);
});

test('Company scope: admin only', () => {
  assert.equal(canReview(R, req('company'), u('ada', 'admin')).ok, true);
  assert.equal(canReview(R, req('company'), u('dora', 'domain_admin')).ok, false);
});

test('NEVER self-approval: the requester is refused whatever their role and whatever the row', () => {
  for (const scope of ['domain', 'company'] as const) {
    const v = canReview(R, req(scope, 'ada'), u('ada', 'admin'));
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /own go-live/);
  }
  const loose: GoLiveRule[] = [{ kind: 'app', scope: 'domain', reviewer: 'builder' }];
  assert.equal(canReview(loose, req('domain', 'bob'), u('bob', 'builder')).ok, false);
  assert.equal(canReview(loose, req('domain', 'carol'), u('bob', 'builder')).ok, true, 'a configured builder row admits another builder');
});

test('no other eligible reviewer: pending, and says so; another eligible person clears it', () => {
  const msg = noEligibleReviewer(R, req('domain', 'dora'), [u('dora', 'domain_admin'), u('bob', 'builder')]);
  assert.equal(msg, 'no other eligible reviewer; an admin can change the rule');
  assert.equal(noEligibleReviewer(R, req('domain', 'dora'), [u('dora', 'domain_admin'), u('ada', 'admin', [])]), null);
});

test('scopeOfVisibility: Personal → my, Shared → domain, Certified → company', () => {
  assert.deepEqual([scopeOfVisibility('Personal'), scopeOfVisibility('Shared'), scopeOfVisibility('Certified')], ['my', 'domain', 'company']);
});

test('currentGoLiveRules reads the store: nothing saved yet ⇒ the defaults, as a copy', async () => {
  const { __setGoLiveRulesMirror } = await import('@core/policy/go-live-rules-store');
  __setGoLiveRulesMirror({ probe: async () => true, read: async () => ({ state: 'absent' }), writeConfirmed: async () => ({ ok: true }) });
  try {
    const rules = await currentGoLiveRules();
    assert.deepEqual(rules, [...R]);
    rules[0].reviewer = 'admin';
    assert.equal(R[0].reviewer, 'none', 'mutating the copy never changes the defaults');
  } finally {
    __setGoLiveRulesMirror(null);
  }
});

test('currentGoLiveRules fails closed: an unreadable store means an admin reviews every row', async () => {
  const { __setGoLiveRulesMirror } = await import('@core/policy/go-live-rules-store');
  __setGoLiveRulesMirror({ probe: async () => false, read: async () => ({ state: 'unreachable' }), writeConfirmed: async () => ({ ok: true }) });
  try {
    const rules = await currentGoLiveRules();
    assert.equal(rules.length, 6);
    assert.ok(rules.every((r) => r.reviewer === 'admin'));
  } finally {
    __setGoLiveRulesMirror(null);
  }
});
