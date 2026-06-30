/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  whatNeedsMe,
  myWip,
  recentActivity,
  cockpitOrder,
  hasAuthored,
  type Viewer,
  type ApprovalInput,
  type ArtifactInput,
  type AppInput,
} from './scope.ts';

const amir: Viewer = { id: 'amir', domains: ['sales'], role: 'participant' };
const bea: Viewer = { id: 'bea', domains: ['sales'], role: 'builder' };
const kenji: Viewer = { id: 'kenji', domains: ['finance'], role: 'participant' };

// A sales approval Amir requested + a sales approval someone else requested.
const approvals: ApprovalInput[] = [
  { id: 'apr_self', kind: 'file_promote', title: 'Promote orders.csv', detail: '…', domain: 'sales', requestedBy: 'amir', status: 'pending', createdAt: '2026-06-20T00:00:00Z' },
  { id: 'apr_other', kind: 'connection_write', title: 'CRM write by churn agent', detail: '…', domain: 'sales', requestedBy: 'bea', status: 'pending', createdAt: '2026-06-21T00:00:00Z' },
  { id: 'apr_fin', kind: 'knowledge_certify', title: 'Certify GL note', detail: '…', domain: 'finance', requestedBy: 'kenji', status: 'pending', createdAt: '2026-06-22T00:00:00Z' },
];

const artifacts: ArtifactInput[] = [
  { id: 'a_amir_draft', type: 'dataset', name: 'Amir draft', owner: 'amir', domain: 'sales', visibility: 'Personal', origin: 'authored', updatedAt: '2026-06-25T00:00:00Z' },
  { id: 'a_bea_shared', type: 'metric', name: 'Sales NRR', owner: 'bea', domain: 'sales', visibility: 'Shared', origin: 'authored', updatedAt: '2026-06-24T00:00:00Z' },
  { id: 'a_fin_shared', type: 'metric', name: 'Gross margin', owner: 'maria', domain: 'finance', visibility: 'Shared', origin: 'authored', updatedAt: '2026-06-23T00:00:00Z' },
];

const apps: AppInput[] = [];

test('RLS: a Builder sees the domain approval queue as ACTIONABLE', () => {
  const needs = whatNeedsMe(bea, approvals, artifacts);
  const other = needs.find((n) => n.id === 'apr_other');
  assert.ok(other, 'builder sees the queued approval');
  assert.equal(other!.actionable, true);
});

test("RLS: a Creator never sees an approval they didn't request, and their own is informational", () => {
  const needs = whatNeedsMe(amir, approvals, artifacts);
  assert.equal(needs.find((n) => n.id === 'apr_other'), undefined, "Amir cannot see Bea's approval");
  const mine = needs.find((n) => n.id === 'apr_self');
  assert.ok(mine, 'Amir sees the approval he requested');
  assert.equal(mine!.actionable, false, 'but only as informational (waiting)');
});

test('RLS: cross-domain never leaks — a finance approval/Shared artifact is invisible to a sales viewer', () => {
  const needs = whatNeedsMe(bea, approvals, artifacts);
  assert.equal(needs.find((n) => n.id === 'apr_fin'), undefined, 'no finance approval for sales builder');
  const recent = recentActivity(bea, artifacts);
  assert.equal(recent.find((r) => r.id === 'a_fin_shared'), undefined, 'no finance Shared item for sales viewer');
  assert.ok(recent.find((r) => r.id === 'a_bea_shared'), 'but in-domain Shared shows');
});

test('Recent activity surfaces newly Certified products cross-domain (discovery)', () => {
  // Certified is cross-domain by design (Marketplace) — it IS discovery, so it
  // appears for any viewer regardless of domain, as a "certified" event.
  const certified: ArtifactInput[] = [
    { id: 'c_cross', type: 'metric', name: 'Daily revenue', owner: 'maria', domain: 'finance', visibility: 'Certified', origin: 'authored', updatedAt: '2026-06-26T00:00:00Z' },
  ];
  const recent = recentActivity(bea, [...artifacts, ...certified]);
  const hit = recent.find((r) => r.id === 'c_cross');
  assert.ok(hit, 'a sales builder sees a finance-certified product as discovery');
  assert.equal(hit!.event, 'certified');
});

test('a second role sees a DIFFERENT What-needs-me — the entitlement proof', () => {
  const amirNeeds = whatNeedsMe(amir, approvals, artifacts).map((n) => n.id).sort();
  const beaNeeds = whatNeedsMe(bea, approvals, artifacts).map((n) => n.id).sort();
  assert.notDeepEqual(amirNeeds, beaNeeds);
});

test('My WIP is owner-scoped Personal-only, isolated across users', () => {
  const amirWip = myWip(amir, artifacts, apps);
  assert.deepEqual(amirWip.map((w) => w.id), ['a_amir_draft']);
  const beaWip = myWip(bea, artifacts, apps);
  assert.equal(beaWip.find((w) => w.id === 'a_amir_draft'), undefined, "Bea cannot see Amir's draft");
  // Bea's only artifact is Shared (not in-flight) → no WIP.
  assert.equal(beaWip.length, 0);
});

test('hasAuthored distinguishes a Creator (owns a draft) from a pure User', () => {
  assert.equal(hasAuthored(amir, artifacts, apps), true);
  assert.equal(hasAuthored(kenji, artifacts, apps), false);
});

test('cockpit ordering differs by persona — Creator leads with drafts, Builder with approvals', () => {
  assert.equal(cockpitOrder('creator')[0], 'needs');
  assert.equal(cockpitOrder('creator')[1], 'wip');
  assert.equal(cockpitOrder('builder')[1], 'pulse');
  assert.notDeepEqual(cockpitOrder('creator'), cockpitOrder('builder'));
  assert.notDeepEqual(cockpitOrder('user'), cockpitOrder('admin'));
});
