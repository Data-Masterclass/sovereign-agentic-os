/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    The reserved-domain check and the schema builders agree (one source, no hand list)
 * USER STORY: As a maintainer I want a change to how personal lanes or domain schemas are named to
 *             move the reserved-domain check with it, never leave it behind.
 * ARCHITECTURE: every personal-lane schema `personalSchema` builds must be refused as a domain id;
 *             a domain id that is NOT reserved must never build a personal-lane schema. Twin: an
 *             ordinary domain's schema is accepted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainSchema, personalSchema } from '@tabs/data/lib/store-fqn';
import { reservedDomainIdReason } from '@core/infra/reserved-domain-ids';

test('every schema personalSchema builds is a refused domain id', () => {
  for (const uid of ['alice', 'bob@example.com', 'x', '', 'Ünïcode User']) {
    const s = personalSchema(uid);
    assert.match(String(reservedDomainIdReason(s)), /personal lane/, s);
  }
});

test('a non-reserved domain id never builds a personal-lane schema', () => {
  for (const id of ['sales', 'personalfinance', 'marketing-eu', 'q3-2026']) {
    assert.equal(reservedDomainIdReason(id), null, id);
    assert.ok(!domainSchema(id).startsWith(personalSchema('x').slice(0, -1)), id);
  }
});
