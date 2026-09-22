/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStatus, deriveBet, completion } from './status.ts';
import { __resetSources, sourceFor } from './sources.ts';
import { type Actor, type ComponentRef } from './model.ts';

const builder: Actor = { id: 'sara', domains: ['sales'], role: 'builder', kind: 'human' };

function ref(partial: Partial<ComponentRef> & Pick<ComponentRef, 'id' | 'artifactId' | 'tab'>): ComponentRef {
  return {
    start: '2026-01-01',
    plannedReady: '2026-03-01',
    dependsOn: [],
    weight: 0,
    origin: 'scaffolded',
    addedBy: 'sara',
    addedAt: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

test('deriveStatus maps each lifecycle to the golden-path three-state', () => {
  assert.equal(deriveStatus('planned'), 'planned');
  assert.equal(deriveStatus(null), 'planned');
  assert.equal(deriveStatus('building'), 'in-progress');
  assert.equal(deriveStatus('draft'), 'in-progress');
  assert.equal(deriveStatus('staging'), 'in-progress');
  assert.equal(deriveStatus('untested'), 'in-progress');
  assert.equal(deriveStatus('certified'), 'completed');
  assert.equal(deriveStatus('promoted'), 'completed');
  assert.equal(deriveStatus('production'), 'completed');
  assert.equal(deriveStatus('tested-governed'), 'completed');
});

test('status is auto-derived live from the artifact; certify flips it to completed', () => {
  __resetSources();
  const data = sourceFor('data').scaffold({ title: 'Churn data', domain: 'sales', bigBetId: 'bet1', by: builder });
  const r = ref({ id: 'r1', artifactId: data.id, tab: 'data' });
  assert.equal(deriveBet([r])[0].derived, 'planned'); // scaffolded → planned

  sourceFor('data').advance(data.id, 'building', builder);
  assert.equal(deriveBet([r])[0].derived, 'in-progress');

  sourceFor('data').advance(data.id, 'certified', builder); // no edit to the bet
  assert.equal(deriveBet([r])[0].derived, 'completed');
});

test('a component is blocked while its dependency is not completed', () => {
  __resetSources();
  const data = sourceFor('data').scaffold({ title: 'Churn data', domain: 'sales', bigBetId: 'b', by: builder });
  const model = sourceFor('ml').scaffold({ title: 'Churn model', domain: 'sales', bigBetId: 'b', by: builder });
  const rData = ref({ id: 'r_data', artifactId: data.id, tab: 'data' });
  const rModel = ref({ id: 'r_model', artifactId: model.id, tab: 'ml', dependsOn: ['r_data'] });

  let s = deriveBet([rData, rModel]);
  assert.equal(s.find((x) => x.refId === 'r_model')!.blocked, true, 'model blocked until data done');
  assert.equal(s.find((x) => x.refId === 'r_model')!.label, 'planned · blocked');

  sourceFor('data').advance(data.id, 'certified', builder);
  s = deriveBet([rData, rModel]);
  assert.equal(s.find((x) => x.refId === 'r_model')!.blocked, false, 'unblocked once data certified');
});

test('completion ratio rolls up the derived states', () => {
  __resetSources();
  const a = sourceFor('data').scaffold({ title: 'A', domain: 'sales', bigBetId: 'b', by: builder });
  const b = sourceFor('dashboard').scaffold({ title: 'B', domain: 'sales', bigBetId: 'b', by: builder });
  sourceFor('data').advance(a.id, 'certified', builder);
  const c = completion(deriveBet([ref({ id: 'ra', artifactId: a.id, tab: 'data' }), ref({ id: 'rb', artifactId: b.id, tab: 'dashboard' })]));
  assert.deepEqual(c, { done: 1, total: 2, pct: 50 });
});
