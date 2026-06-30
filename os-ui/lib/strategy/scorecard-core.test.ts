/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScorecard,
  selfServiceArea,
  foundationType,
  FOUNDATION_TYPES,
} from './scorecard-core.ts';
import type { Artifact } from '@/lib/artifact-model';
import type { Role } from '@/lib/session';

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

const USERS: { id: string; role: Role }[] = [
  { id: 'amir', role: 'participant' },
  { id: 'sara', role: 'creator' },
  { id: 'bea', role: 'builder' },
  { id: 'cas', role: 'builder' },
  { id: 'maria', role: 'admin' },
];

test('selfServiceArea maps types + kind tags to the three creation areas', () => {
  assert.equal(selfServiceArea({ type: 'dashboard', tags: [] }), 'analytics');
  assert.equal(selfServiceArea({ type: 'dataset', tags: [] }), 'analytics');
  assert.equal(selfServiceArea({ type: 'metric', tags: [] }), 'analytics');
  assert.equal(selfServiceArea({ type: 'agent', tags: [] }), 'ai');
  assert.equal(selfServiceArea({ type: 'file', tags: ['kind:ml'] }), 'ai');
  assert.equal(selfServiceArea({ type: 'file', tags: ['kind:software'] }), 'software');
  assert.equal(selfServiceArea({ type: 'knowledge', tags: [] }), null);
});

test('foundationType covers the eight governed types (tag overrides win); dashboards excluded', () => {
  assert.equal(foundationType({ type: 'agent', tags: [] }), 'agent');
  assert.equal(foundationType({ type: 'knowledge', tags: [] }), 'knowledge');
  assert.equal(foundationType({ type: 'dataset', tags: [] }), 'data');
  assert.equal(foundationType({ type: 'transformation', tags: [] }), 'data');
  assert.equal(foundationType({ type: 'metric', tags: [] }), 'metric');
  assert.equal(foundationType({ type: 'file', tags: [] }), 'files');
  assert.equal(foundationType({ type: 'connection', tags: [] }), 'connection');
  assert.equal(foundationType({ type: 'file', tags: ['kind:software'] }), 'software');
  assert.equal(foundationType({ type: 'file', tags: ['kind:ml'] }), 'science');
  assert.equal(foundationType({ type: 'dashboard', tags: [] }), null);
  assert.equal(FOUNDATION_TYPES.length, 8);
});

test('self service counts DISTINCT creators per area across all tiers (draft+)', () => {
  const arts = [
    art({ id: 'd1', type: 'dashboard', owner: 'amir', domain: 'sales', visibility: 'Personal' }),
    art({ id: 'd2', type: 'dataset', owner: 'amir', domain: 'sales', visibility: 'Shared' }), // same creator → still 1
    art({ id: 'm1', type: 'metric', owner: 'sara', domain: 'sales', visibility: 'Personal' }),
    art({ id: 'ag', type: 'agent', owner: 'bea', domain: 'sales', visibility: 'Personal' }),
    art({ id: 'sw', type: 'file', owner: 'cas', domain: 'sales', visibility: 'Personal', tags: ['kind:software'] }),
  ];
  const sc = buildScorecard(arts, USERS);
  assert.equal(sc.selfService.analytics, 2); // amir + sara
  assert.equal(sc.selfService.ai, 1); // bea
  assert.equal(sc.selfService.software, 1); // cas
  assert.equal(sc.selfService.totalUsers, 5);
  assert.equal(sc.selfService.builders, 2); // bea + cas
  assert.equal(sc.selfService.creators, 1); // sara
});

test('foundations count only promoted + certified (tier ≥ promoted), by type', () => {
  const arts = [
    art({ id: 'a1', type: 'agent', owner: 'bea', domain: 'sales', visibility: 'Certified' }),
    art({ id: 'a2', type: 'agent', owner: 'bea', domain: 'sales', visibility: 'Shared' }),
    art({ id: 'a3', type: 'agent', owner: 'amir', domain: 'sales', visibility: 'Personal' }), // draft → not a foundation
    art({ id: 'k1', type: 'knowledge', owner: 'maria', domain: 'platform', visibility: 'Shared' }),
    art({ id: 'da1', type: 'dataset', owner: 'sara', domain: 'sales', visibility: 'Certified' }),
    art({ id: 'dash', type: 'dashboard', owner: 'sara', domain: 'sales', visibility: 'Certified' }), // excluded
  ];
  const sc = buildScorecard(arts, USERS);
  assert.equal(sc.foundations.agent, 2); // a1 + a2 (not the personal a3)
  assert.equal(sc.foundations.knowledge, 1);
  assert.equal(sc.foundations.data, 1);
  // dashboards are not a foundation type — they contribute to nothing here.
  assert.equal(FOUNDATION_TYPES.reduce((n, t) => n + sc.foundations[t], 0), 4);
});

test('certified-copies are excluded from both sections (not new authored work)', () => {
  const arts = [
    art({ id: 'orig', type: 'agent', owner: 'bea', domain: 'sales', visibility: 'Certified' }),
    art({ id: 'copy', type: 'agent', owner: 'amir', domain: 'sales', visibility: 'Certified', origin: 'certified-copy' }),
  ];
  const sc = buildScorecard(arts, USERS);
  assert.equal(sc.foundations.agent, 1);
  assert.equal(sc.selfService.ai, 1); // only bea, the author
});
