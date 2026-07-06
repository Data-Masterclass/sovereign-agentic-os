/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getWorkflow, getDomainKnowledge } from '@/lib/knowledge/store';
import { indexWorkflow, indexDomain } from '@/lib/knowledge/index-pipeline';
import { promoteThroughSeam } from '@/lib/governance/ladder';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

type Params = { params: Promise<{ id: string }> };

/**
 * POST → publish (draft→live, Personal→Shared) or certify (Shared→Marketplace).
 * The rung is derived from the workflow's current tier and applied THROUGH the
 * governance effect seam (never a direct publishWorkflow/certifyWorkflow — the
 * former back door is closed). Gate: publish needs Builder+; certify needs Admin
 * (both re-enforced inside the seam's per-kind applier).
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { action?: 'publish' | 'certify' };
    // Honour the caller's INTENT: publish→rung 1, certify→rung 2. A mismatch with
    // the workflow's tier is a typed conflict, never a silent tier jump.
    const rung = body.action === 'certify' ? 'certify' : 'promote';
    await promoteThroughSeam('knowledge', id, user, { rung });
    const rec = getWorkflow(id, user);

    // On publish, the indexing pipeline runs (best-effort — must not fail the flip).
    try {
      await indexWorkflow(rec.workflow, { owner: rec.owner, tacit: rec.tacit, updatedAt: rec.updatedAt });
      await indexDomain(getDomainKnowledge(rec.domain));
    } catch {
      /* indexing is best-effort; the publish already succeeded */
    }

    return NextResponse.json({
      id: rec.id,
      status: rec.status,
      visibility: rec.visibility,
      publishedAt: rec.publishedAt,
      publishedBy: rec.publishedBy,
    });
  } catch (e) {
    return fail(e);
  }
}
