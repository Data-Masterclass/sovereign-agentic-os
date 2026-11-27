/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (W0) - names keyed on domain and slug (spec 2b), the shared contracts
 * USER STORY: As the platform owner I want two apps with the same slug in two domains to get disjoint names for
 *             every Kubernetes object and Postgres identifier, and every name to be valid, short enough and stable.
 * ARCHITECTURE: Pure functions; the SHA-256 is checked against node:crypto. Negative twins: the collisions a plain
 *             `app-<domain>-<slug>[-<part>]` would have (a/b-c vs a-b/c; app x's preview vs app x-p1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  APP_RESOURCE_PARTS,
  appAudience,
  appDbIdent,
  appNameHash,
  appResourceName,
  sha256Hex,
  templateVersionOf,
  CRITERIA_RESULT,
  DIGEST_RESULT,
  STORIES_DIR,
  APP_ENV_NAMESPACE_DEFAULT,
  type CriterionRef,
  type LivingSpec,
  type SpecProposal,
  type AppRelease,
} from './app-builder-contracts.ts';

const RFC1123 = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;
const PG = /^[a-z][a-z0-9_]*$/;
const node = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

test('sha256Hex equals node:crypto for empty, ASCII, multi-block and UTF-8 input', () => {
  for (const s of ['', 'abc', 'sales/order-desk', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(1000), 'Vertrieb/bestellung-ä€😀']) {
    assert.equal(sha256Hex(s), node(s), JSON.stringify(s.slice(0, 20)));
  }
});

test('appResourceName: app-<domain>-<slug>-<h8>[-<part>], h8 = first 8 hex of sha256("<domain>/<slug>")', () => {
  const h8 = node('sales/order-desk').slice(0, 8);
  assert.equal(appNameHash('sales', 'order-desk'), h8);
  assert.equal(appResourceName('sales', 'order-desk'), `app-sales-order-desk-${h8}`);
  for (const p of APP_RESOURCE_PARTS) assert.equal(appResourceName('sales', 'order-desk', p), `app-sales-order-desk-${h8}-${p}`);
});

test('same slug in two domains ⇒ disjoint names for every object, Secret, Job and the database/role', () => {
  const names = (d: string) => [appResourceName(d, 'orders'), ...APP_RESOURCE_PARTS.map((p) => appResourceName(d, 'orders', p)), appDbIdent(d, 'orders')];
  const a = names('sales');
  const b = names('finance');
  for (const n of a) assert.ok(!b.includes(n), `${n} is shared by two domains`);
  assert.equal(new Set([...a, ...b]).size, a.length + b.length);
});

test('NEGATIVE twin: the separator collisions of a plain name do not happen', () => {
  // (domain a, slug b-c) and (domain a-b, slug c) both read "app-a-b-c" without the hash
  assert.notEqual(appResourceName('a', 'b-c'), appResourceName('a-b', 'c'));
  assert.notEqual(appDbIdent('a', 'b_c'), appDbIdent('a_b', 'c'));
  // app x's preview slot vs app "x-p1"'s Deployment, in one domain
  assert.notEqual(appResourceName('d', 'x', 'p1'), appResourceName('d', 'x-p1'));
  assert.notEqual(appResourceName('d', 'x', 'db'), appResourceName('d', 'x-db'));
  // a domain with capitals or dots maps to the same cleaned text, but not the same name
  assert.notEqual(appResourceName('Sales.EU', 'x'), appResourceName('sales-eu', 'x'));
});

test('charset and length hold for awkward input; the cut is stable and always ends in the hash (and part)', () => {
  const longDomain = 'a-very-long-domain-name-that-goes-on-and-on-forever';
  const longSlug = 'an-equally-long-application-slug-with-many-words-in-it';
  for (const [d, s] of [['sales', 'x'], ['Sales.EU_West', 'my-app'], [longDomain, longSlug], ['d', 'a'.repeat(63)], ['---', '---']]) {
    for (const p of [undefined, ...APP_RESOURCE_PARTS]) {
      const n = appResourceName(d, s, p);
      assert.ok(n.length <= 63, `${n} is ${n.length} chars`);
      assert.match(n, RFC1123, n);
      assert.ok(n.endsWith(`${appNameHash(d, s)}${p ? `-${p}` : ''}`), n);
      assert.equal(appResourceName(d, s, p), n, 'stable');
    }
    const id = appDbIdent(d, s);
    assert.ok(Buffer.byteLength(id) <= 63, `${id} is ${Buffer.byteLength(id)} bytes`);
    assert.match(id, PG, id);
    assert.ok(id.endsWith(`_${appNameHash(d, s)}`), id);
  }
  const cut = appResourceName(longDomain, longSlug, 'migrate');
  assert.equal(cut.length, 63);
  assert.ok(!cut.includes('--'));
  // two long names that share their first 63 characters stay apart through the hash
  assert.notEqual(appResourceName(longDomain, `${longSlug}-one`), appResourceName(longDomain, `${longSlug}-two`));
  assert.notEqual(appDbIdent(longDomain, `${longSlug}-one`), appDbIdent(longDomain, `${longSlug}-two`));
});

test('an unknown part is refused (the set is closed)', () => {
  assert.throws(() => appResourceName('d', 's', 'secret' as never), /unknown app resource part/);
});

test('appAudience names domain, slug and env; templateVersionOf: absent ⇒ 1', () => {
  assert.equal(appAudience('sales', 'orders', 'dev'), 'app:sales/orders:dev');
  assert.notEqual(appAudience('sales', 'orders', 'dev'), appAudience('sales', 'orders', 'prod'));
  assert.equal(templateVersionOf({}), 1);
  assert.equal(templateVersionOf({ templateVersion: 1 }), 1);
  assert.equal(templateVersionOf({ templateVersion: 2 }), 2);
});

test('the contracts compile and the constants are the plan\'s', () => {
  const ref: CriterionRef = 'US-3/AC-2';
  const spec: LivingSpec = { sha: 'a'.repeat(40), epics: [], stories: [{ id: 'US-3', epic: 'EP-1', title: 't', asA: 'a', iWant: 'b', soThat: 'c', state: 'agreed', criteria: [{ id: 'AC-2', title: 'x', given: ['g'], when: ['w'], then: ['t'] }], notes: '', path: 'stories/EP-1-x/US-3-y.md' }] };
  const p: SpecProposal = { id: 'p1', appId: 'app_1', classification: 'new-story', rationale: '', confidence: 1, alternatives: [], change: { writes: [], deletes: [], summary: '' }, source: 'chat', posthoc: false, requestedBy: 'u', status: 'pending', createdAt: 't' };
  const r: AppRelease = { id: 'r1', slug: 's', env: 'dev', sha: 'a', digest: 'sha256:x', at: 't', by: 'u', previous: null, migrations: { applied: [], status: 'none' }, state: 'running' };
  assert.ok(ref && spec && p && r);
  assert.deepEqual([CRITERIA_RESULT, DIGEST_RESULT, STORIES_DIR], ['criteria', 'digest', 'stories']);
  assert.deepEqual(APP_ENV_NAMESPACE_DEFAULT, { dev: 'apps-dev', prod: 'apps-prod' });
});
