/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { churnSlice } from '@/lib/science';

export const dynamic = 'force-dynamic';

/**
 * The "Churn model" vertical slice state for the Science tab. Probes the Layer-4
 * backends (Featureform / MLflow / KServe) server-side and degrades to a
 * deterministic seed so the 8-stage golden path renders end-to-end even with
 * `ml.enabled=false` and no cluster. No secrets leave the server.
 */
export async function GET() {
  if (!config.mlEnabled) {
    return NextResponse.json({ error: 'Science (Layer 4) is off — ml.enabled=false' }, { status: 404 });
  }
  const slice = await churnSlice();
  return NextResponse.json(slice);
}
