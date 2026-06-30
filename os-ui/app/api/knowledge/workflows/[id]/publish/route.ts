/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { publishWorkflow, certifyWorkflow, getDomainKnowledge } from '@/lib/knowledge/store';
import { parseWorkflow } from '@/lib/knowledge/schema';
import { indexWorkflow, indexDomain } from '@/lib/knowledge/index-pipeline';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

type Params = { params: Promise<{ id: string }> };

/**
 * POST → publish (draft→live) or certify (live→Marketplace).
 * Body: { action: 'publish' | 'certify' }
 * Gate: publish requires builder+; certify requires admin.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const action = body.action === 'certify' ? 'certify' : 'publish';

    const rec = action === 'certify'
      ? certifyWorkflow(id, user)
      : publishWorkflow(id, user);

    // On publish, the indexing pipeline runs (the Dagster sensor of the design).
    // Best-effort: index failures must not fail the publish itself.
    try {
      const wf = parseWorkflow(rec.md);
      await indexWorkflow(wf, { owner: rec.owner, tacit: rec.tacit, updatedAt: rec.updatedAt });
      await indexDomain(getDomainKnowledge(rec.domain));
    } catch {
      /* indexing is best-effort; publish already succeeded */
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
