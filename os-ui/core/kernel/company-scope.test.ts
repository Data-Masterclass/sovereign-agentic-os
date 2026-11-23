/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core/kernel
 * FEATURE:    The one Company-scope rule — promoted to Company ⇒ visible in every domain
 * USER STORY: As a member of any domain I see every Company artifact, whichever domain built it,
 *             while My and Domain items of other domains stay invisible to me.
 * ARCHITECTURE:
 *   - Pure unit tests over `core/kernel/company-scope.ts` (and the picker narrowing that uses it).
 *   - The per-kind behaviour (list / get / search / MCP / no edit, plus the Domain negative twin)
 *     is pinned in each tab's `lib/domain-scope.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCompanyScope, inLiveDomainScope } from '@core/kernel/company-scope';
import { inDomainScope } from '@core/kernel/domain-scope';

test('isCompanyScope: every tab vocabulary for the Company rung, and nothing below it', () => {
  for (const w of ['product', 'Marketplace', 'marketplace', 'Certified', 'certified', 'company', ' Company ']) {
    assert.equal(isCompanyScope(w), true, w);
  }
  for (const w of ['dataset', 'asset', 'Personal', 'personal', 'Shared', 'shared', 'domain', 'private', 'public', '', null, undefined]) {
    assert.equal(isCompanyScope(w as string), false, String(w));
  }
  assert.equal(isCompanyScope({ tier: 'product' }), true);
  assert.equal(isCompanyScope({ visibility: 'Certified' }), true);
  assert.equal(isCompanyScope({ scope: 'marketplace' }), true);
  assert.equal(isCompanyScope({ tier: 'asset', visibility: 'domain' }), false);
});

test('inLiveDomainScope: Company in every domain; My/Domain only in their own; domainless always', () => {
  assert.equal(inLiveDomainScope({ company: true, domain: 'sales' }, ['finance']), true);
  assert.equal(inLiveDomainScope({ company: false, domain: 'sales' }, ['finance']), false, 'negative twin');
  assert.equal(inLiveDomainScope({ company: false, domain: 'sales' }, ['sales']), true);
  assert.equal(inLiveDomainScope({ company: false, domain: '' }, ['finance']), true);
});

test('the picker narrowing (domain-scope.ts) uses the same rule', () => {
  assert.equal(inDomainScope({ scope: 'marketplace', domain: 'sales' }, 'finance'), true);
  assert.equal(inDomainScope({ scope: 'domain', domain: 'sales' }, 'finance'), false);
});
