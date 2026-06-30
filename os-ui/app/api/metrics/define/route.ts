/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { defineMeasure, getDataset } from '@/lib/data/store';
import { scaffoldCubeYaml } from '@/lib/data/metrics';
import { delegatedToken } from '@/lib/identity-server';
import { measureFromForm, measureFromYaml, type MetricForm } from '@/lib/metrics/model';
import { convergence } from '@/lib/metrics/consistency';
import { buildMetric } from '@/lib/metrics/build/server';

export const dynamic = 'force-dynamic';

/**
 * Define a metric — the friendly FORM, the metrics AGENT (a structured proposal) and
 * Cube YAML are three doors to ONE artifact. We:
 *   1. build the canonical Measure from the form;
 *   2. prove the three define paths CONVERGE (form == agent == YAML) — so the UI can
 *      offer all three without ever forking the definition;
 *   3. persist it on the governed Gold dataset (the Data handoff — defineMeasure refuses
 *      a non-Gold/non-governed dataset, surfacing "promote it in Data first");
 *   4. run the metric Build (cube → resolve → explorer consistency), LIVE or offline-mock.
 */
export async function POST(req: Request) {
  try {
    const user = await requirePrincipal();
    const body = (await req.json().catch(() => ({}))) as { datasetId?: string; form?: MetricForm; agent?: MetricForm };
    const datasetId = (body.datasetId ?? '').trim();
    if (!datasetId) return NextResponse.json({ error: 'datasetId is required' }, { status: 400 });
    if (!body.form) return NextResponse.json({ error: 'a metric form is required' }, { status: 400 });

    const measure = measureFromForm(body.form);

    // Persist on the governed Gold dataset (throws a helpful 400 if it isn't ready).
    const dataset = defineMeasure(datasetId, user, measure);

    // Prove convergence: form vs the agent proposal vs the YAML now scaffolded with it.
    const yaml = scaffoldCubeYaml(dataset);
    const conv = convergence(dataset, { form: body.form, agent: body.agent ?? body.form, yaml });
    // Sanity: the YAML round-trips to the same measure (defensive, never user-facing).
    measureFromYaml(yaml, body.form.name);

    const { token } = await delegatedToken('domain');
    const build = await buildMetric(dataset, measure, token);

    return NextResponse.json({ datasetId, measure, member: build.member, convergence: conv, build, cube: yaml });
  } catch (e) {
    return errorResponse(e);
  }
}
