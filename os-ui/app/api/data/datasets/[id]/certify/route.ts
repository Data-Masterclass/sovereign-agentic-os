/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/data/lib/server';
import { certify, requestCertification, getDataset, policyPushReport, personalDataStatus, parsePersonalDataConfirmation, PersonalDataGateError } from '@tabs/data/lib/store';
import { ensureHydrated as ensureSettingsHydrated } from '@tabs/admin/lib/settings';
import { enqueue, listApprovals } from '@core/policy/approvals';
import type { Grant, TrustLevel } from '@tabs/data/lib/index';

export const dynamic = 'force-dynamic';

/**
 * Certify → Data Product (data-architecture-model.md), Admin-gated:
 *   POST { action:'certify' } — a domain ADMIN certifies directly (the certification
 *           badge + dataProduct + marketplace listing + broadened visibility).
 *   POST { action:'request' } — a Builder/owner requests certification; an Admin
 *           approves it in Governance (a `dataset_certify` approval). Mirrors promotion.
 *   GET   — the asset's certification status (pending request, if any) and what the
 *           personal-data rule (admin setting) would decide if it were certified now.
 * A certify refused by the personal-data rule answers 409 with `code` and `personalData`
 * (the unmasked / unclassified columns and the fix) so the panel can show them.
 */
export const POST = withRoute<{ id: string }, { action?: 'certify' | 'request'; level?: TrustLevel; grants?: Grant[]; personalData?: { confirmed?: boolean; reason?: string } }>(async ({ user, params, body }) => {
  const { id } = params;

  if (body.action === 'certify') {
    await ensureSettingsHydrated(); // the saved personal-data rule, not the fail-closed default
    let product;
    try {
      product = certify(id, user, { level: body.level, grants: body.grants, personalData: parsePersonalDataConfirmation(body.personalData) });
    } catch (e) {
      if (e instanceof PersonalDataGateError) {
        return NextResponse.json({ error: e.message, code: e.code, personalData: e.personalData }, { status: e.status });
      }
      throw e;
    }
    // The immediate OPA push (Company ⇒ readable in every domain) — a failure is shown, never silent.
    return NextResponse.json({ dataset: product, ...(await policyPushReport(product.id)) });
  }

  // request → enqueue for an Admin
  const existing = listApprovals({ status: 'pending' }).find(
    (a) => a.kind === 'dataset_certify' && a.payload?.datasetId === id,
  );
  if (existing) return NextResponse.json({ approval: existing, already: true });

  const request = requestCertification(id, user, { level: body.level });
  const approval = enqueue({
    kind: 'dataset_certify',
    title: `Certify “${request.datasetName}” as a data product`,
    detail: `${user.id} requests certifying ${request.datasetName} (trust: ${request.level}) as a Company data product — readable by every domain; column masks still apply. A platform Admin must approve.`,
    agent: user.id,
    domain: request.domain,
    requestedBy: user.id,
    tool: 'data_certify',
    payload: request as unknown as Record<string, unknown>,
    // Certification is a platform-Admin decision (tenant scope) — NOT the default
    // builder/domain, so a domain Builder can never approve a marketplace listing.
    approverRole: 'admin',
    scope: 'tenant',
  });
  return NextResponse.json({ approval });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });

export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const dataset = getDataset(id, user); // view-scope guard
  await ensureSettingsHydrated();
  const pd = personalDataStatus(id, user);
  const pending = listApprovals().find(
    (a) => a.kind === 'dataset_certify' && a.payload?.datasetId === id,
  );
  return NextResponse.json({
    tier: dataset.tier,
    certification: dataset.certification ?? null,
    imports: dataset.imports ?? [],
    request: pending ?? null,
    personalData: { rule: pd.rule.rule, ruleKnown: pd.rule.known, ...pd.check },
  });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
