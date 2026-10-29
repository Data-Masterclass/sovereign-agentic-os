/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@tabs/data/lib/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { defineMeasure, getDataset } from '@tabs/data/lib/store';
import { scaffoldMetricYaml } from '@tabs/data/lib/metrics';
import { delegatedToken } from '@core/infra/identity-server';
import { measureFromForm, measureFromYaml, type MetricForm } from '@tabs/metrics/lib/model';
import { convergence } from '@tabs/metrics/lib/consistency';
import { buildMetric } from '@tabs/metrics/lib/build/server';

export const dynamic = 'force-dynamic';

/**
 * Define a metric — the friendly FORM, the metrics AGENT (a structured proposal) and
 * Cube YAML are three doors to ONE artifact. We:
 *   1. build the canonical Measure from the form;
 *   2. prove the three define paths CONVERGE (form == agent == YAML) — so the UI can
 *      offer all three without ever forking the definition;
 *   3. persist it on the governed Gold dataset (the Data handoff — defineMeasure refuses
 *      a non-Gold/non-governed dataset, surfacing "promote it in Data first");
 *   4. run the metric Build (compile → resolve → explorer consistency), LIVE or offline-mock.
 */
export const POST = withRoute<Record<string, string>, { datasetId?: string; form?: MetricForm; agent?: MetricForm }>(async ({ user, body }) => {
  const datasetId = (body.datasetId ?? '').trim();
  if (!datasetId) return NextResponse.json({ error: 'datasetId is required' }, { status: 400 });
  if (!body.form) return NextResponse.json({ error: 'a metric form is required' }, { status: 400 });

  // A composite formula validates against the dataset's EXISTING measures — a clear
  // 400 naming the missing/non-basic reference, never a downstream no-SQL pending.
  const measure = measureFromForm(body.form, getDataset(datasetId, user).measures);

  // Persist on the governed Gold dataset (throws a helpful 400 if it isn't ready).
  const dataset = defineMeasure(datasetId, user, measure);

  // Prove convergence: form vs the agent proposal vs the YAML now scaffolded with it.
  const yaml = scaffoldMetricYaml(dataset);
  const conv = convergence(dataset, { form: body.form, agent: body.agent ?? body.form, yaml });
  // Sanity: the YAML round-trips to the same measure (defensive, never user-facing).
  measureFromYaml(yaml, body.form.name);

  const { token } = await delegatedToken('domain');
  const build = await buildMetric(dataset, measure, token);

  // The metric is ALREADY persisted (defineMeasure above). If the only reason the build
  // isn't green is Cube sync lag (the sidecar hasn't pushed the measure yet), report it
  // as pending (200) — the value converges within a few seconds — never a lost metric.
  return NextResponse.json({
    datasetId,
    measure,
    member: build.member,
    convergence: conv,
    build,
    definitionYaml: yaml,
    ...(build.pending ? { pending: true } : {}),
  });
}, { gate: requirePrincipal as () => Promise<CurrentUser>, parse: true });
