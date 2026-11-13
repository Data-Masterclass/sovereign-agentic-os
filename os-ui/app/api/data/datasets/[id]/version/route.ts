/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/data/lib/server';
import { stepperStages } from '@tabs/data/lib/panels';
import { commitVersionService } from '@tabs/data/lib/mutations-server';
import { type Quality } from '@tabs/data/lib/index';

export const dynamic = 'force-dynamic';

/**
 * Commit one medallion version (the guided panel's "Confirm"). Bronze "Bring it in"
 * is committed AFTER the data has landed (preview-before-commit, via the physical
 * ingest pipeline). Silver/Gold go through `commitVersionService` → `commitLayerVersion`: a
 * pass-through runs a REAL governed CTAS copy of the prior layer and an authored
 * commit is probed against its physical table — the version (and its dot) is
 * registered ONLY on a ✓ build report, never optimistically.
 */
export const POST = withRoute<{ id: string }, { layer?: string; quality?: Quality; passThrough?: boolean; artifactBody?: string }>(async ({ user, params, body }) => {
  // `commitVersionService` is the ONE honest commit path, shared with MCP `add_dataset_version`
  // (checklist X8): the prior-layer gate, the materialize-or-probe build and the registration.
  const outcome = await commitVersionService(user, params.id, {
    layer: body.layer,
    quality: body.quality,
    passThrough: body.passThrough,
    body: body.artifactBody,
  });
  if (!outcome.ok || !outcome.dataset) {
    // Honest ✗: nothing was registered — surface the build report + real reason.
    return NextResponse.json({ build: outcome.build, error: outcome.error ?? `${String(body.layer)} build did not pass` }, { status: 200 });
  }
  return NextResponse.json({ build: outcome.build, dataset: outcome.dataset, stages: stepperStages(outcome.dataset) });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
