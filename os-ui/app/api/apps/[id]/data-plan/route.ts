/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { resolveDataPlanItem } from '@/lib/software/data-plan-server';
import { normalizeSuggestedDatasets } from '@/lib/software/data-plan';

export const dynamic = 'force-dynamic';

/**
 * POST { dataset: SuggestedDataset } → RESOLVE one create-new data need (0.6.101).
 * Creates the governed dataset (empty or with AI dummy rows), materializes its bronze
 * through the shared ingest path, and grants it to the app so the build sees its schema.
 * The BIND-existing action stays the pre-existing grants PATCH — this route is only the
 * create-new (empty/dummy) resolve. Edit-scope + duplicate-name are enforced in the lib.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const { id } = params;
  const body = (await req.json().catch(() => ({}))) as { dataset?: unknown };
  // Re-validate the item server-side (same normalizer the assistant reply used) so a
  // malformed/hand-crafted body can never create a column-less dataset.
  const items = normalizeSuggestedDatasets(body.dataset ? [body.dataset] : []);
  if (!items || items.length === 0) {
    return NextResponse.json(
      { error: 'A dataset with a name and at least one column is required.' },
      { status: 400 },
    );
  }
  const result = await resolveDataPlanItem(id, user, items[0]);
  return NextResponse.json(result);
}, { defaultStatus: 500 });
