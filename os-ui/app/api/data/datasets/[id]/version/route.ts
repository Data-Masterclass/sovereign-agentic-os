/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/data/server';
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
export const POST = withRoute<{ id: string }, { layer?: string; quality?: Quality; passThrough?: boolean; artifactBody?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  const layer = body.layer as Layer;
  if (!LAYERS.includes(layer)) {
    return NextResponse.json({ error: `layer must be one of ${LAYERS.join('|')}` }, { status: 400 });
  }
  const current = getDataset(id, user);
  const passThrough = Boolean(body.passThrough);
  // A pass-through carries the newest LOWER layer forward (resolvePassThroughSource probes
  // silver→bronze for gold), so a Gold pass-through is valid whenever ANY lower layer
  // exists — not only when the immediate prior (silver) is built. This is what lets an
  // ingested dataset auto-materialize `gold_<slug>` straight off a raw Bronze ingest (the
  // simplified Data Edit surface, which removed the manual Gold UI). An AUTHORED build still
  // needs its immediate prior via canBuildStage.
  const priorPresent = passThrough
    ? current.versions.bronze.built || current.versions.silver.built
    : canBuildStage(current.versions, layer);
  if (!priorPresent) {
    return NextResponse.json({ error: `bring in the prior layer before building ${layer}` }, { status: 400 });
  }
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
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
