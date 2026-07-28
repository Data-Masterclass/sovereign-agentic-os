/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The ONE deliberate exception to strict domain isolation: the dedicated MARKETPLACE
 * CATALOG surface is cross-domain, while every PER-TAB list is domain-narrowed.
 *
 * This pins both halves at once on lib/core/artifacts.ts:
 *   • listForUser        — the per-tab workspace list → domain-isolated (Certified
 *     catalog items are EXCLUDED from normal tabs; a Shared item narrows to its domain).
 *   • listMarketplace    — the cross-domain discovery catalog → NOT domain-narrowed:
 *     a Certified artifact certified in domain A is discoverable by a user acting in
 *     domain B (that is how it gets adopted into another domain).
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { __resetArtifactsCache, createArtifact, promoteArtifact, listForUser, listMarketplace } from './artifacts.ts';
import type { CurrentUser } from './auth.ts';

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

test('the same Certified artifact is NOT in a finance user’s PER-TAB list (strict isolation)', async () => {
  const a = await createArtifact(salesAdmin, { type: 'metric', name: 'Daily revenue', domain: 'sales' });
  await promoteArtifact(a.id, salesAdmin);
  await promoteArtifact(a.id, salesAdmin); // Certified

  // Per-tab list for a finance user: the sales-domain item must NOT leak in.
  const finTab = await listForUser(financeAdmin);
  assert.ok(!finTab.some((x) => x.id === a.id), 'sales-certified artifact must NOT show in a finance user’s per-tab list');
});

test('a Shared artifact narrows to its domain in the per-tab list', async () => {
  const a = await createArtifact(salesAdmin, { type: 'metric', name: 'Sales KPI', domain: 'sales' });
  await promoteArtifact(a.id, salesAdmin); // Shared (domain sales)

  assert.ok((await listForUser(salesAdmin)).some((x) => x.id === a.id), 'sales user sees the Shared sales artifact');
  assert.ok(!(await listForUser(financeAdmin)).some((x) => x.id === a.id), 'finance user does NOT see the Shared sales artifact');
});
