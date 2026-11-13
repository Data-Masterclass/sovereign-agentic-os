/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { getWorkflow, getDomainKnowledge } from '@tabs/knowledge/lib/store';
import { indexWorkflow, indexDomain } from '@tabs/knowledge/lib/index-pipeline';
import { actingCaller } from '@tabs/knowledge/lib/embed';

export const dynamic = 'force-dynamic';

/**
 * POST → run the indexing pipeline for this workflow (+ its domain card):
 * unit-chunk → embed (sovereign-embed) → OpenSearch (with the in-process mirror).
 * This is what the publish-time Dagster sensor does; exposed here for re-index.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const view = getWorkflow(id, user);
    // A27: attribute the embed spend to the user who asked for the re-index.
    const caller = actingCaller(user.id, view.domain);
    const wfReport = await indexWorkflow(view.workflow, {
      owner: view.owner,
      tacit: view.tacit,
      updatedAt: view.updatedAt,
      caller,
    });
    const domainReport = await indexDomain(getDomainKnowledge(view.domain), caller);
    return NextResponse.json({ workflow: wfReport, domain: domainReport });
}, { defaultStatus: 500 });
