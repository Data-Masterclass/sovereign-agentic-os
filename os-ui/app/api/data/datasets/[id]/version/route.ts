/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { buildVersion, getDataset } from '@/lib/data/store';
import { stepperStages, stageArtifact, canBuildStage, canPassThrough } from '@/lib/data/panels';
import { LAYERS, type Layer, type Quality } from '@/lib/data/dataset-schema';

export const dynamic = 'force-dynamic';

/**
 * Commit one medallion version (the guided panel's "Confirm"). Bronze "Bring it in"
 * is committed AFTER the data has landed in the sandbox (preview-before-commit, via
 * /api/data/sandbox); this route records the version + its native artifact path.
 * Pass-through carries the prior version forward unchanged.
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
    const dataset = buildVersion(id, user, layer, {
      quality: body.quality,
      passThrough,
      // Pass-through keeps no own artifact; an authored layer points at its native file.
      artifact: passThrough ? null : stageArtifact(current.name, layer),
      body: passThrough ? undefined : body.artifactBody,
    });
    return NextResponse.json({ dataset, stages: stepperStages(dataset) });
  } catch (e) {
    return errorResponse(e);
  }
}
