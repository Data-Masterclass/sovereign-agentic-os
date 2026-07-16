/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { getDataset } from '@/lib/data/store';
import { stepperStages, canBuildStage, canPassThrough } from '@/lib/data/panels';
import { commitLayerVersion } from '@/lib/data/build/server';
import { LAYERS, type Layer, type Quality } from '@/lib/data';

export const dynamic = 'force-dynamic';

/**
 * Commit one medallion version (the guided panel's "Confirm"). Bronze "Bring it in"
 * is committed AFTER the data has landed (preview-before-commit, via the physical
 * ingest pipeline). Silver/Gold go through {@link commitLayerVersion}: a
 * pass-through runs a REAL governed CTAS copy of the prior layer and an authored
 * commit is probed against its physical table — the version (and its dot) is
 * registered ONLY on a ✓ build report, never optimistically.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as {
      layer?: string;
      quality?: Quality;
      passThrough?: boolean;
      /** Authored dbt SQL + tests for Silver/Gold (the guided "Show the code" body). */
      artifactBody?: string;
    };
    const layer = body.layer as Layer;
    if (!LAYERS.includes(layer)) {
      return NextResponse.json({ error: `layer must be one of ${LAYERS.join('|')}` }, { status: 400 });
    }
    const current = getDataset(id, user);
    if (!canBuildStage(current.versions, layer)) {
      return NextResponse.json({ error: `bring in the prior layer before building ${layer}` }, { status: 400 });
    }
    const passThrough = Boolean(body.passThrough);
    if (passThrough && !canPassThrough(layer)) {
      return NextResponse.json({ error: 'Bronze is the entry point — there is nothing to pass through' }, { status: 400 });
    }
    const outcome = await commitLayerVersion(current, layer, user, {
      passThrough,
      quality: body.quality,
      body: body.artifactBody,
    });
    if (!outcome.ok || !outcome.dataset) {
      // Honest ✗: nothing was registered — surface the build report + real reason.
      return NextResponse.json({ build: outcome.build, error: outcome.error ?? `${layer} build did not pass` }, { status: 200 });
    }
    return NextResponse.json({ build: outcome.build, dataset: outcome.dataset, stages: stepperStages(outcome.dataset) });
  } catch (e) {
    return errorResponse(e);
  }
}
