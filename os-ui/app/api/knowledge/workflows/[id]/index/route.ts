/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getWorkflow, getDomainKnowledge } from '@/lib/knowledge/store';
import { indexWorkflow, indexDomain } from '@/lib/knowledge/index-pipeline';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

type Params = { params: Promise<{ id: string }> };

/**
 * POST → run the indexing pipeline for this workflow (+ its domain card):
 * unit-chunk → embed (sovereign-embed) → OpenSearch (with the in-process mirror).
 * This is what the publish-time Dagster sensor does; exposed here for re-index.
 */
export async function POST(_req: Request, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const view = getWorkflow(id, user);
    const wfReport = await indexWorkflow(view.workflow, {
      owner: view.owner,
      tacit: view.tacit,
      updatedAt: view.updatedAt,
    });
    const domainReport = await indexDomain(getDomainKnowledge(view.domain));
    return NextResponse.json({ workflow: wfReport, domain: domainReport });
  } catch (e) {
    return fail(e);
  }
}
