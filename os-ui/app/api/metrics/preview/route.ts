/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { getDataset } from '@/lib/data/store';
import { delegatedToken } from '@/lib/identity-server';
import { measureFromForm, type MetricForm } from '@/lib/metrics/model';
import { exploreMetric } from '@/lib/metrics/build/explore-server';
import type { Granularity } from '@/lib/metrics/explorer';

export const dynamic = 'force-dynamic';

/**
 * LIVE preview of an UNSAVED metric — the guided editor's "see the number before you
 * save" affordance. We build the candidate Measure from the SAME {@link MetricForm} the
 * Define endpoint uses, splice it onto a TRANSIENT copy of the host dataset, and run the
 * SAME governed explorer query path ({@link exploreMetric}) under the viewer's delegated
 * identity (R3 RLS) — live against Cube when reachable, honest offline-mock otherwise.
 * Nothing is persisted; this is a read-only dry run through the identical member the
 * saved metric will resolve, so the preview number IS the metric number. No Cube URL or
 * token reaches the browser.
 */
export async function POST(req: Request) {
  try {
    const user = await requirePrincipal();
    const body = (await req.json().catch(() => ({}))) as {
      datasetId?: string;
      form?: MetricForm;
      dimensions?: string[];
      timeDimension?: string;
      granularity?: Granularity;
      viewerRegion?: string;
      limit?: number;
    };
    const datasetId = (body.datasetId ?? '').trim();
    if (!datasetId) return NextResponse.json({ error: 'datasetId is required' }, { status: 400 });
    if (!body.form) return NextResponse.json({ error: 'a metric form is required' }, { status: 400 });

    // Build the candidate measure (validates the form) and splice it onto a transient
    // dataset — never persisted, so a preview can never register a half-formed metric.
    const measure = measureFromForm(body.form);
    const dataset = getDataset(datasetId, user);
    const draft = { ...dataset, measures: [...dataset.measures.filter((m) => m.name !== measure.name), measure] };

    const { token } = await delegatedToken('domain', { region: body.viewerRegion });
    const result = await exploreMetric(draft, measure, token, {
      dimensions: body.dimensions,
      timeDimension: body.timeDimension,
      granularity: body.granularity,
      limit: body.limit,
    });
    return NextResponse.json({ datasetId, measure, ...result });
  } catch (e) {
    return errorResponse(e);
  }
}
