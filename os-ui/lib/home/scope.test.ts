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
  topItems,
  type Viewer,
  type ApprovalInput,
  type ArtifactInput,
  type AppInput,
  type TopBetInput,
  type TopPillarInput,
} from './scope.ts';

const amir: Viewer = { id: 'amir', domains: ['sales'], role: 'creator' };
const bea: Viewer = { id: 'bea', domains: ['sales'], role: 'builder' };
const kenji: Viewer = { id: 'kenji', domains: ['finance'], role: 'creator' };

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

// ---- Top items per artifact (the scannable board) --------------------------

// A richer fixture: many artifact types + 5 datasets (to prove the per-type cap)
// + apps, bets, pillars. All rows here are ones the viewer is entitled to see.
const boardArtifacts: ArtifactInput[] = [
  ...['d1', 'd2', 'd3', 'd4', 'd5'].map((id, i) => ({
    id, type: 'dataset', name: `Dataset ${id}`, owner: 'amir', domain: 'sales',
    visibility: 'Personal' as const, origin: 'authored' as const,
    updatedAt: `2026-06-2${i}T00:00:00Z`,
  })),
  { id: 'm1', type: 'metric', name: 'Sales NRR', owner: 'bea', domain: 'sales', visibility: 'Shared', origin: 'authored', updatedAt: '2026-06-24T00:00:00Z' },
  { id: 'dash1', type: 'dashboard', name: 'Pipeline', owner: 'amir', domain: 'sales', visibility: 'Shared', origin: 'authored', updatedAt: '2026-06-23T00:00:00Z' },
  { id: 'k1', type: 'knowledge', name: 'Playbook', owner: 'amir', domain: 'sales', visibility: 'Certified', origin: 'certified-copy', updatedAt: '2026-06-22T00:00:00Z' },
];
const boardApps: AppInput[] = [
  { id: 'app1', name: 'Quote tool', owner: 'amir', domain: 'sales', visibility: 'Personal', updatedAt: '2026-06-26T00:00:00Z' },
];
const boardBets: TopBetInput[] = [
  { id: 'bet1', name: 'Reduce churn', domain: 'sales', status: 'active', updatedAt: '2026-06-25T00:00:00Z' },
];
const boardPillars: TopPillarInput[] = [
  { id: 'p1', name: 'Grow revenue', scope: 'tenant', updatedAt: '2026-06-20T00:00:00Z' },
];

test('top items groups by type and omits empty types (honest empty state)', () => {
  const groups = topItems(amir, boardArtifacts, boardApps, boardBets, boardPillars);
  const keys = groups.map((g) => g.key);
  assert.deepEqual(keys.includes('dataset'), true);
  assert.deepEqual(keys.includes('metric'), true);
  assert.deepEqual(keys.includes('software'), true);
  assert.deepEqual(keys.includes('big-bets'), true);
  assert.deepEqual(keys.includes('strategy'), true);
  // No agents/files/connections/transformations in the fixture → no empty cards.
  assert.equal(keys.includes('agent'), false);
  assert.equal(keys.includes('connection'), false);
});

test('top items caps each type but keeps the true total in count (for "+N more")', () => {
  const groups = topItems(amir, boardArtifacts, boardApps, boardBets, boardPillars);
  const datasets = groups.find((g) => g.key === 'dataset')!;
  assert.equal(datasets.items.length, 4, 'shows at most 4');
  assert.equal(datasets.count, 5, 'but reports all 5 available');
  // Most-recent first (d5 updated 2026-06-24 is newest of the five).
  assert.equal(datasets.items[0].id, 'd5');
});

test('top items: an empty registry yields no groups (a fresh tenant shows nothing tastefully)', () => {
  assert.deepEqual(topItems(kenji, [], [], [], []), []);
});

test('top items only ever surface the pre-scoped rows passed in (RLS boundary held upstream)', () => {
  // The shaper is pure over its inputs — the feed adapter fetches with the
  // viewer's identity (listForUser/listBets/listPillars), so a row the viewer
  // cannot see is never passed here. Proof: pass only sales rows → every emitted
  // id traces back to an input row, nothing is invented.
  const groups = topItems(amir, boardArtifacts, boardApps, boardBets, boardPillars);
  const inputIds = new Set([
    ...boardArtifacts.map((a) => a.id),
    ...boardApps.map((a) => a.id),
    ...boardBets.map((b) => b.id),
    ...boardPillars.map((p) => p.id),
  ]);
  for (const g of groups) for (const it of g.items) assert.ok(inputIds.has(it.id), `${it.id} came from input`);
});
