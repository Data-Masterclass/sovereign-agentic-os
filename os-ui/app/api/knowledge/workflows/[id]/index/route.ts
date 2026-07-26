/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getWorkflow, getDomainKnowledge } from '@/lib/knowledge/store';
import { indexWorkflow, indexDomain } from '@/lib/knowledge/index-pipeline';

export const dynamic = 'force-dynamic';

/**
 * POST → run the indexing pipeline for this workflow (+ its domain card):
 * unit-chunk → embed (sovereign-embed) → OpenSearch (with the in-process mirror).
 * This is what the publish-time Dagster sensor does; exposed here for re-index.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const view = getWorkflow(id, user);
    const wfReport = await indexWorkflow(view.workflow, {
      owner: view.owner,
      tacit: view.tacit,
      updatedAt: view.updatedAt,
    });
    const domainReport = await indexDomain(getDomainKnowledge(view.domain));
    return NextResponse.json({ workflow: wfReport, domain: domainReport });
}, { defaultStatus: 500 });
