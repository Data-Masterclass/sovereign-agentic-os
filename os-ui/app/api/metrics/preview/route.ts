/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/data/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { getDataset } from '@/lib/data/store';
import { metricSqlReady } from '@/lib/data/metrics';
import { delegatedToken } from '@/lib/infra/identity-server';
import { measureFromForm, sameMeasure, type MetricForm } from '@/lib/metrics/model';
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
export const POST = withRoute<Record<string, string>, {
  datasetId?: string;
  form?: MetricForm;
  dimensions?: string[];
  timeDimension?: string;
  granularity?: Granularity;
  viewerRegion?: string;
  limit?: number;
}>(async ({ user, body }) => {
  const datasetId = (body.datasetId ?? '').trim();
  if (!datasetId) return NextResponse.json({ error: 'datasetId is required' }, { status: 400 });
  if (!body.form) return NextResponse.json({ error: 'a metric form is required' }, { status: 400 });

  // Build the candidate measure (validates the form) and splice it onto a transient
  // dataset — never persisted, so a preview can never register a half-formed metric.
  const measure = measureFromForm(body.form);
  const dataset = getDataset(datasetId, user);
  // SQL-READY gate (metrics→Trino migration, Phase 1): the preview serves the metric as
  // governed Trino SQL over the TIER-AWARE physical gold mart, read AS the viewer — so a
  // BUILT gold of ANY tier is enough (a personal dataset reads its own personal lane). We
  // still fail closed on a dataset with no built gold, with the honest "build a Gold first"
  // answer rather than a raw Trino TABLE_NOT_FOUND.
  const ready = metricSqlReady(dataset);
  if (!ready.ok) return NextResponse.json({ error: ready.message }, { status: 400 });
  const draft = { ...dataset, measures: [...dataset.measures.filter((m) => m.name !== measure.name), measure] };
  // UNSAVED = no identical persisted measure: Cube can't know this member yet (the
  // sidecar only ships persisted metrics), so exploreMetric previews it via governed
  // SQL ('live (sql)') instead of querying Cube for a member that can't exist.
  const unsaved = !dataset.measures.some((m) => sameMeasure(m, measure));

  const { token } = await delegatedToken('domain', { region: body.viewerRegion });
  const result = await exploreMetric(draft, measure, token, {
    dimensions: body.dimensions,
    timeDimension: body.timeDimension,
    granularity: body.granularity,
    limit: body.limit,
  }, { unsaved });
  return NextResponse.json({ datasetId, measure, ...result });
}, { gate: requirePrincipal as () => Promise<CurrentUser>, parse: true });
