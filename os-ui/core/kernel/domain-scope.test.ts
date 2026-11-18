/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core/kernel
 * FEATURE:    The shared "does this artifact belong in a feed narrowed to one domain" predicate
 * USER STORY: As an admin in four domains I must not be offered another domain's artifacts while
 *             I work in one of them — and nothing I can see today may vanish without a reason.
 * ARCHITECTURE:
 *   - Pure unit tests over `core/kernel/domain-scope.ts`; no stores, no fixtures, no I/O.
 *   - Pins the three carve-outs that make the narrowing safe: a null target keeps everything,
 *     marketplace is always kept, and a domainless artifact is always kept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inDomainScope, narrowToDomainScope } from '@core/kernel/domain-scope';

const TARGET = 'agentic-leader-autumn-winter-2026-2027';
const FOREIGN = 'agentic-leader-q3-2026';

test('DOMAIN-SCOPE: a personal item is kept only when its own domain is the target', () => {
  assert.equal(inDomainScope({ scope: 'personal', domain: TARGET }, TARGET), true);
  assert.equal(inDomainScope({ scope: 'personal', domain: FOREIGN }, TARGET), false);
});

test('DOMAIN-SCOPE: a domain-scope item is kept only when its own domain is the target', () => {
  assert.equal(inDomainScope({ scope: 'domain', domain: TARGET }, TARGET), true);
  assert.equal(inDomainScope({ scope: 'domain', domain: FOREIGN }, TARGET), false);
});

test('DOMAIN-SCOPE: marketplace is ALWAYS kept — cross-domain discovery is the Marketplace’s job', () => {
  assert.equal(inDomainScope({ scope: 'marketplace', domain: FOREIGN }, TARGET), true);
  assert.equal(inDomainScope({ scope: 'marketplace' }, TARGET), true);
});

test('DOMAIN-SCOPE: a domainless (unassigned) artifact is always kept, so an admin can still move it', () => {
  assert.equal(inDomainScope({ scope: 'personal' }, TARGET), true);
  assert.equal(inDomainScope({ scope: 'personal', domain: '' }, TARGET), true);
  assert.equal(inDomainScope({ scope: 'domain', domain: null }, TARGET), true);
});

test('DOMAIN-SCOPE: a NULL target has no domain context — nothing is narrowed away', () => {
  assert.equal(inDomainScope({ scope: 'personal', domain: FOREIGN }, null), true);
  assert.equal(inDomainScope({ scope: 'domain', domain: FOREIGN }, null), true);
});

test('DOMAIN-SCOPE: narrowToDomainScope filters a list and preserves order + every other field', () => {
  const items = [
    { id: 'a', scope: 'personal' as const, domain: TARGET, folder: '/reports' },
    { id: 'b', scope: 'personal' as const, domain: FOREIGN, folder: '/northpeak' },
    { id: 'c', scope: 'domain' as const, domain: TARGET, folder: '/' },
    { id: 'd', scope: 'marketplace' as const, domain: FOREIGN },
  ];
  const kept = narrowToDomainScope(items, TARGET);
  assert.deepEqual(kept.map((i) => i.id), ['a', 'c', 'd']);
  assert.equal(kept[0].folder, '/reports', 'the item object is passed through untouched');
  assert.equal(narrowToDomainScope(items, null).length, 4, 'a null target narrows nothing');
});
