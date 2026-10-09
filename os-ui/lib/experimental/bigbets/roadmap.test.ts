/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollup } from './roadmap.ts';
import { deriveBet } from './status.ts';
import { __resetSources, sourceFor } from './sources.ts';
import { type Actor, type ComponentRef } from './model.ts';

const builder: Actor = { id: 'sara', domains: ['sales'], role: 'builder', kind: 'human' };

function ref(p: Partial<ComponentRef> & Pick<ComponentRef, 'id' | 'artifactId' | 'tab' | 'plannedReady'>): ComponentRef {
  return { start: '2026-01-01', dependsOn: [], weight: 0, origin: 'scaffolded', addedBy: 'sara', addedAt: '2026-01-01T00:00:00Z', ...p };
}

test('a passed planned-ready date while still draft is at-risk', () => {
  __resetSources();
  const a = sourceFor('dashboard').scaffold({ title: 'Dash', domain: 'sales', bigBetId: 'b', by: builder });
  sourceFor('dashboard').advance(a.id, 'draft', builder);
  const r = ref({ id: 'r1', artifactId: a.id, tab: 'dashboard', plannedReady: '2026-03-01' });
  const out = rollup([r], deriveBet([r]), '2026-06-01', '2026-06-30'); // today past plannedReady
  assert.equal(out.components[0].readiness, 'at-risk');
  assert.ok((out.components[0].daysLate ?? 0) > 0);
  assert.equal(out.goLiveRealistic, false);
});

test('a completed component reads done and is never at-risk', () => {
  __resetSources();
  const a = sourceFor('data').scaffold({ title: 'D', domain: 'sales', bigBetId: 'b', by: builder });
  sourceFor('data').advance(a.id, 'certified', builder);
  const r = ref({ id: 'r1', artifactId: a.id, tab: 'data', plannedReady: '2026-01-01' });
  const out = rollup([r], deriveBet([r]), '2026-06-01', '2026-12-31');
  assert.equal(out.components[0].readiness, 'done');
  assert.equal(out.signal, 'done');
});

test('blocked shows distinctly from at-risk; slippage cascades to dependents', () => {
  __resetSources();
  const data = sourceFor('data').scaffold({ title: 'Data', domain: 'sales', bigBetId: 'b', by: builder });
  sourceFor('data').advance(data.id, 'building', builder);
  const model = sourceFor('ml').scaffold({ title: 'Model', domain: 'sales', bigBetId: 'b', by: builder });

  const rData = ref({ id: 'r_data', artifactId: data.id, tab: 'data', plannedReady: '2026-03-01' });
  const rModel = ref({ id: 'r_model', artifactId: model.id, tab: 'ml', plannedReady: '2026-12-01', dependsOn: ['r_data'] });

  // today past the data's planned date → data at-risk; model blocked by the unfinished data.
  const out = rollup([rData, rModel], deriveBet([rData, rModel]), '2027-01-01', '2026-06-30');
  assert.equal(out.components.find((c) => c.refId === 'r_data')!.readiness, 'at-risk');
  assert.equal(out.components.find((c) => c.refId === 'r_model')!.readiness, 'blocked');
  assert.equal(out.blocked, 1);
  assert.equal(out.atRisk, 1);
});

test('% complete and go-live realism roll up across components', () => {
  __resetSources();
  const a = sourceFor('data').scaffold({ title: 'A', domain: 'sales', bigBetId: 'b', by: builder });
  const b = sourceFor('dashboard').scaffold({ title: 'B', domain: 'sales', bigBetId: 'b', by: builder });
  sourceFor('data').advance(a.id, 'certified', builder);
  const refs = [
    ref({ id: 'ra', artifactId: a.id, tab: 'data', plannedReady: '2026-02-01' }),
    ref({ id: 'rb', artifactId: b.id, tab: 'dashboard', plannedReady: '2026-07-01' }),
  ];
  const out = rollup(refs, deriveBet(refs), '2026-08-01', '2026-06-01'); // before B's planned date
  assert.equal(out.pct, 50);
  assert.equal(out.goLiveRealistic, true); // B planned before go-live, nothing at-risk yet
});
