/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Company scope on the kernel artifact registry (owner decision 2026-11-23,
 * core/kernel/company-scope): a Certified artifact is visible in EVERY domain, while My
 * and Domain stay narrowed to the caller's domains.
 *
 * This pins both surfaces on lib/core/artifacts.ts:
 *   • listForUser        — the per-tab workspace list → a Certified artifact from another
 *     domain IS listed; a Shared item narrows to its domain (negative twin).
 *   • listMarketplace    — the cross-domain discovery catalog → NOT domain-narrowed:
 *     a Certified artifact certified in domain A is discoverable by a user acting in
 *     domain B (that is how it gets adopted into another domain).
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { __resetArtifactsCache, createArtifact, promoteArtifact, listForUser, listMarketplace } from '@core/kernel/artifacts';
import type { CurrentUser } from '@core/kernel/auth';

// Author acts in sales; the viewer acts in a DIFFERENT domain (finance).
const salesAdmin: CurrentUser = { id: 'a1', name: 'A1', domains: ['sales'], role: 'admin', allDomains: ['sales'], activeDomain: 'sales' };
const financeAdmin: CurrentUser = { id: 'f1', name: 'F1', domains: ['finance'], role: 'admin', allDomains: ['finance'], activeDomain: 'finance' };

beforeEach(() => __resetArtifactsCache());

test('a Certified artifact from domain A appears in the cross-domain Marketplace CATALOG (not narrowed)', async () => {
  const a = await createArtifact(salesAdmin, { type: 'metric', name: 'Daily revenue', domain: 'sales' });
  await promoteArtifact(a.id, salesAdmin); // Personal → Shared
  await promoteArtifact(a.id, salesAdmin); // Shared → Certified

  // The dedicated Marketplace catalog is cross-domain: a finance user discovers the
  // sales-certified artifact there. Do NOT narrow this surface.
  const catalog = await listMarketplace();
  assert.ok(catalog.some((x) => x.id === a.id), 'Certified sales artifact must appear in the cross-domain Marketplace catalog');
});

test('the same Certified artifact IS in a finance user’s per-tab list (Company scope)', async () => {
  const a = await createArtifact(salesAdmin, { type: 'metric', name: 'Daily revenue', domain: 'sales' });
  await promoteArtifact(a.id, salesAdmin);
  await promoteArtifact(a.id, salesAdmin); // Certified

  // Owner decision 2026-11-23 (core/kernel/company-scope): Company is visible in every domain.
  const finTab = await listForUser(financeAdmin);
  assert.ok(finTab.some((x) => x.id === a.id), 'sales-certified artifact shows in a finance user’s per-tab list');
});

test('a Shared artifact narrows to its domain in the per-tab list', async () => {
  const a = await createArtifact(salesAdmin, { type: 'metric', name: 'Sales KPI', domain: 'sales' });
  await promoteArtifact(a.id, salesAdmin); // Shared (domain sales)

  assert.ok((await listForUser(salesAdmin)).some((x) => x.id === a.id), 'sales user sees the Shared sales artifact');
  assert.ok(!(await listForUser(financeAdmin)).some((x) => x.id === a.id), 'finance user does NOT see the Shared sales artifact');
});
