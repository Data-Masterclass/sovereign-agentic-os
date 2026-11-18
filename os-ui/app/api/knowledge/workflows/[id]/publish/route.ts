/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { canPromote } from '@core/kernel/session';
import { getWorkflow, getDomainKnowledge } from '@tabs/knowledge/lib/store';
import { indexWorkflow, indexDomain } from '@tabs/knowledge/lib/index-pipeline';
import { actingCaller } from '@tabs/knowledge/lib/embed';
import { promoteThroughSeam, fileArtifactPromotion, fileArtifactCertification } from '@core/policy/ladder';

export const dynamic = 'force-dynamic';

/**
 * POST → publish (draft→live, Personal→Shared) or certify (Shared→Marketplace).
 * The rung is derived from the workflow's current tier and applied THROUGH the
 * governance effect seam (never a direct publishWorkflow/certifyWorkflow — the
 * former back door is closed).
 *
 * Separation of duties (docs-first): a Builder+ promotes / an Admin certifies in
 * one shot; a creator (owner without the gate) FILES request_promotion for a
 * Builder to approve — the same ladder every artifact rides.
 */
export const POST = withRoute<{ id: string }, { action?: 'publish' | 'certify' }>(async ({ user, params, body }) => {
    const { id } = params;
    // Honour the caller's INTENT: publish→rung 1, certify→rung 2. A mismatch with
    // the workflow's tier is a typed conflict, never a silent tier jump.
    const rung = body.action === 'certify' ? 'certify' : 'promote';

    // A caller without the APPROVER authority for this rung files the governed request and
    // hands off, rather than taking a 403. The gate MUST be the same `canPromote` the store's
    // `publishWorkflow` / `certifyWorkflow` enforce (domain_admin+ to publish, admin to
    // certify): it used to read `roleAtLeast('builder')` here, so a BUILDER who owned a draft
    // was sent down the one-shot path and met "Only domain admins and admins can publish
    // workflows" — a dead end with no request filed and nothing to approve.
    const canAct = canPromote(user.role, rung === 'certify' ? 'Shared' : 'Personal');
    if (!canAct) {
      const approval = rung === 'certify'
        ? await fileArtifactCertification('knowledge', id, user)
        : await fileArtifactPromotion('knowledge', id, user);
      return NextResponse.json({ requested: true, approval });
    }

    await promoteThroughSeam('knowledge', id, user, { rung });
    const rec = getWorkflow(id, user);

    // On publish, the indexing pipeline runs (best-effort — must not fail the flip). A3 review:
    // the OUTCOME is reported instead of swallowed. A gateway rejection (no scoped key, the alias
    // off the allowlist, a budget cap) means the published unit is NOT retrievable yet, and the
    // caller has to be able to see that — `indexing: { ok: false, code }` rather than a silent
    // success that leaves the knowledge invisible to every agent.
    let indexing: { ok: true } | { ok: false; code: string; error: string } = { ok: true };
    try {
      const caller = actingCaller(user.id, rec.domain); // A27: the publisher pays for the embed
      await indexWorkflow(rec.workflow, { owner: rec.owner, tacit: rec.tacit, updatedAt: rec.updatedAt, caller });
      await indexDomain(getDomainKnowledge(rec.domain), caller);
    } catch (e) {
      const err = e as Error & { name?: string; code?: string };
      indexing = { ok: false, code: err?.code ?? err?.name ?? 'index_failed', error: err?.message ?? String(e) };
    }

    return NextResponse.json({
      id: rec.id,
      status: rec.status,
      visibility: rec.visibility,
      publishedAt: rec.publishedAt,
      publishedBy: rec.publishedBy,
      indexing,
    });
}, { parse: true, defaultStatus: 500 });
