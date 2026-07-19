/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { config } from '@/lib/core/config';
import { getDataset } from '@/lib/data/store';
import { getMetric } from '@/lib/metrics/store';
import { datasetToTmdl, tmdlFilename, measureMappings } from '@/lib/metrics/powerbi/tmdl';

export const dynamic = 'force-dynamic';

/**
 * Export a governed metric/dataset as a Power BI **TMDL semantic model** (#143). The
 * TMDL is GENERATED one-way from the OS Cube view (the single source of truth) so a
 * business user in Power BI gets the governed measures/dimensions WITHOUT redefining
 * them. It binds (DirectQuery) to the Cube SQL endpoint as the `bi_<domain>` principal,
 * so Cube → Trino → OPA RLS applies exactly as the `.pbids` connect does.
 *
 * GOVERNANCE: the model is resolved through the SAME governed store the Metrics/Data
 * tabs use — `getMetric`/`getDataset` throw 403/404 unless the caller can VIEW it. So a
 * user can only export a metric they are already entitled to see (same canView scope).
 *
 * SQL API availability: if `CUBE_SQL_API_ENABLED` is false the endpoint the TMDL would
 * point at is closed, so we return 503 (mirrors the `.pbids` route) rather than emit a
 * model that points at a dead port.
 *
 * ?metricId=<datasetId.measure>  — export the metric's dataset view (governed).
 * ?datasetId=<id>                — export the dataset's view directly (governed).
 * ?format=json                   — return { tmdl, filename, mappings } instead of a file
 *                                   download (so a UI can preview the Cube→DAX mapping).
 */
export async function GET(req: Request) {
  try {
    const user = await requirePrincipal();
    const url = new URL(req.url);
    const metricId = url.searchParams.get('metricId');
    const datasetId = url.searchParams.get('datasetId');
    const asJson = url.searchParams.get('format') === 'json';

    if (!metricId && !datasetId) {
      const err = new Error('metricId or datasetId is required') as Error & { status?: number };
      err.status = 400;
      throw err;
    }

    // Resolve through the governed store: throws 403/404 unless the caller can VIEW it.
    // This IS the export's governance gate — same canView scope as the metric.
    const dataset = metricId ? getMetric(metricId, user).dataset : getDataset(datasetId as string, user);

    if (!config.cubeSqlApiEnabled) {
      const err = new Error(
        'The Cube SQL API is not enabled on this instance. A Power BI semantic model needs a live governed endpoint to bind to — ask your platform admin to set CUBE_SQL_API_ENABLED=true and expose the SQL API port.',
      ) as Error & { status?: number };
      err.status = 503;
      throw err;
    }

    const endpoint = { host: config.cubeSqlHost, port: config.cubeSqlPort };
    const tmdl = datasetToTmdl(dataset, { endpoint });
    const filename = tmdlFilename(dataset);

    if (asJson) {
      return NextResponse.json(
        { tmdl, filename, mappings: measureMappings(dataset) },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    return new NextResponse(tmdl, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
