/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tallyAdoption, kindOf } from './adoption-core.ts';
import type { Artifact } from '@/lib/core/artifact-model';
import type { Role } from '@/lib/core/session';

function art(p: Partial<Artifact> & Pick<Artifact, 'id' | 'type' | 'owner' | 'domain' | 'visibility'>): Artifact {
  return {
    name: p.id,
    description: '',
    origin: 'authored',
    tags: [],
    spec: {},
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-20T00:00:00Z',
    ...p,
  } as Artifact;
}

const ROLES = new Map<string, Role>([
  ['amir', 'creator'],
  ['sara', 'admin'],
  ['bea', 'builder'],
  ['maria', 'admin'],
]);

const NOW = Date.parse('2026-06-27T00:00:00Z');
const CUTOFF = NOW - 90 * 24 * 60 * 60 * 1000;

test('kindOf maps registry types to scoreboard kinds (tag override wins)', () => {
  assert.equal(kindOf({ type: 'dataset', tags: [] }), 'data');
  assert.equal(kindOf({ type: 'transformation', tags: [] }), 'data');
  assert.equal(kindOf({ type: 'metric', tags: [] }), 'metric');
  assert.equal(kindOf({ type: 'agent', tags: [] }), 'agent');
  assert.equal(kindOf({ type: 'knowledge', tags: [] }), null);
  // A future software/ml row tags itself.
  assert.equal(kindOf({ type: 'file', tags: ['kind:software'] }), 'software');
});

test('certified data products are counted by domain at the certified tier', () => {
  const arts = [
    art({ id: 'd1', type: 'dataset', owner: 'sara', domain: 'sales', visibility: 'Certified' }),
    art({ id: 'd2', type: 'dataset', owner: 'amir', domain: 'sales', visibility: 'Shared' }),
    art({ id: 'd3', type: 'dataset', owner: 'amir', domain: 'sales', visibility: 'Personal' }),
    art({ id: 'm1', type: 'metric', owner: 'maria', domain: 'finance', visibility: 'Certified' }),
  ];
  const board = tallyAdoption(arts, ROLES, { windowDays: 90, cutoff: CUTOFF });
  const sales = board.domains.find((d) => d.domain === 'sales')!;
  assert.equal(sales.counts.data.certified, 1); // d1
  assert.equal(sales.counts.data.promoted, 1); // d2 (Shared = promoted); Personal not counted
  // Tenant roll-up sums across domains.
  assert.equal(board.tenant.counts.data.certified, 1);
  assert.equal(board.tenant.counts.metric.certified, 1);
});

test('certifying one more data product increments the live count (no manual edit)', () => {
  const base = [art({ id: 'd1', type: 'dataset', owner: 'sara', domain: 'sales', visibility: 'Certified' })];
  const before = tallyAdoption(base, ROLES, { windowDays: 90, cutoff: CUTOFF });
  assert.equal(before.domains.find((d) => d.domain === 'sales')!.counts.data.certified, 1);
  // Promote a second dataset to Certified — the only state change.
  const after = tallyAdoption(
    [...base, art({ id: 'd2', type: 'dataset', owner: 'sara', domain: 'sales', visibility: 'Certified' })],
    ROLES,
    { windowDays: 90, cutoff: CUTOFF },
  );
  assert.equal(after.domains.find((d) => d.domain === 'sales')!.counts.data.certified, 2);
});

test('active people are derived from recent authoring activity, split by role, de-duped', () => {
  const arts = [
    art({ id: 'a1', type: 'dataset', owner: 'amir', domain: 'sales', visibility: 'Personal' }),
    art({ id: 'a2', type: 'dashboard', owner: 'amir', domain: 'sales', visibility: 'Shared' }), // same creator, de-dupe
    art({ id: 'a3', type: 'agent', owner: 'bea', domain: 'sales', visibility: 'Shared' }), // builder
    art({ id: 'a4', type: 'metric', owner: 'amir', domain: 'sales', visibility: 'Shared', updatedAt: '2025-01-01T00:00:00Z' }), // stale: ignored
  ];
  const board = tallyAdoption(arts, ROLES, { windowDays: 90, cutoff: CUTOFF });
  const sales = board.domains.find((d) => d.domain === 'sales')!;
  assert.equal(sales.activeCreators, 1); // amir, once
  assert.equal(sales.activeBuilders, 1); // bea
});

test('certified-copies are excluded (not new authored work)', () => {
  const arts = [
    art({ id: 'orig', type: 'dataset', owner: 'sara', domain: 'sales', visibility: 'Certified' }),
    art({ id: 'copy', type: 'dataset', owner: 'amir', domain: 'sales', visibility: 'Certified', origin: 'certified-copy' }),
  ];
  const board = tallyAdoption(arts, ROLES, { windowDays: 90, cutoff: CUTOFF });
  assert.equal(board.tenant.counts.data.certified, 1);
});

test('domainFilter restricts the board to one domain (domain pillar scoreboard)', () => {
  const arts = [
    art({ id: 'd1', type: 'dataset', owner: 'sara', domain: 'sales', visibility: 'Certified' }),
    art({ id: 'm1', type: 'metric', owner: 'maria', domain: 'finance', visibility: 'Certified' }),
  ];
  const board = tallyAdoption(arts, ROLES, { windowDays: 90, cutoff: CUTOFF, domainFilter: 'sales' });
  assert.equal(board.domains.length, 1);
  assert.equal(board.domains[0].domain, 'sales');
});
