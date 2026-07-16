/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tier-1 consolidation tests: the Big Bets picker + value spine read REAL cross-tab
 * data (not empty mocks), scoped by each tab's own canView, and the realized-value
 * metric path resolves a real linked metric.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sourceFor, __resetSources } from './sources.ts';
import { realizedValue } from './value.ts';
import { createBet, __resetBets } from './store.ts';
import { listRealArtifacts } from './real-sources.ts'; // side-effect: registers the real reader
import { createDataset, __resetStore as __resetData } from '@/lib/data';
import '@/lib/strategy/pillars'; // side-effect: pins the governed metric catalogue to globalThis
import type { Actor, Principal } from './model.ts';

const alice: Principal = { id: 'alice', domains: ['sales'], role: 'builder' };
const bob: Principal = { id: 'bob', domains: ['research'], role: 'builder' }; // other domain, non-owner
const admin: Principal = { id: 'root', domains: ['sales', 'research'], role: 'admin' };
const aliceActor: Actor = { ...alice, kind: 'human' };

function reset() {
  __resetSources();
  __resetBets();
  __resetData();
}

test('picker: sourceFor(tab).list({viewer}) surfaces a REAL dataset the viewer owns', () => {
  reset();
  const d = createDataset(alice, { name: 'Churn mart' }); // personal (dataset tier), domain sales

  const seen = sourceFor('data').list({ viewer: alice });
  const hit = seen.find((a) => a.id === d.id);
  assert.ok(hit, 'the real dataset appears in the picker for its owner');
  assert.equal(hit!.title, 'Churn mart');
  assert.equal(hit!.tab, 'data');
  assert.equal(hit!.visibility, 'personal', 'a fresh dataset maps to a personal reference card');
});

test('picker: canView scoping — the tab\'s OWN gate rules; a non-owner never sees a personal draft', () => {
  reset();
  const d = createDataset(alice, { name: 'Sales-only mart' }); // personal, domain sales

  // The picker defers to each tab's own governed list(user) — the Data tab only
  // surfaces a personal draft to its owner, so no other principal (a different
  // domain, or even an admin) can link it through the picker. No leakage.
  const bobSees = sourceFor('data').list({ viewer: bob }).some((a) => a.id === d.id);
  assert.equal(bobSees, false, 'a research-domain builder cannot see a sales personal dataset');

  const adminSees = sourceFor('data').list({ viewer: admin }).some((a) => a.id === d.id);
  assert.equal(adminSees, false, 'even an admin does not see another user\'s personal draft — the Data gate decides');

  // Owner (positive control) still sees their own draft.
  assert.equal(sourceFor('data').list({ viewer: alice }).some((a) => a.id === d.id), true);

  // The reader itself is scoped (defence in depth): bob gets nothing of alice's.
  assert.equal(listRealArtifacts('data', bob).some((a) => a.id === d.id), false);
});

test('value: realized value reflects a REAL linked metric (catalogue-resolved)', () => {
  reset();
  // finance.grossMargin: uplift basis, baseline €400k, seedTotal €760k → €360k uplift.
  const bet = createBet(aliceActor, {
    name: 'Lift gross margin',
    problem: { who: 'Finance', need: 'raise margin', obstacle: 'leakage', impact: '€360k' },
    pillarId: 'pillar_finance',
    metricId: 'finance.grossMargin',
    valueBasis: 'uplift',
    targetValue: 500_000,
    goLive: '2026-12-01',
  });

  const r = realizedValue(bet, alice.id);
  assert.equal(r.metricResolved, true, 'a real linked metric resolves');
  assert.equal(r.baseline, 400_000);
  assert.equal(r.current, 760_000);
  assert.equal(r.realized, 360_000, 'uplift = current − baseline, from the real metric');
});

test('value: no metric linked → honest empty state (metricResolved false, not a misleading €0 claim)', () => {
  reset();
  const bet = createBet(aliceActor, {
    name: 'Unmetered bet',
    problem: { who: 'Ops', need: 'do a thing', obstacle: 'none', impact: 'tbd' },
    pillarId: 'pillar_ops',
    targetValue: 100_000,
    goLive: '2026-12-01',
  });

  const r = realizedValue(bet, alice.id);
  assert.equal(r.metricResolved, false, 'no metric linked is signalled honestly');
  assert.equal(r.realized, 0);
});
