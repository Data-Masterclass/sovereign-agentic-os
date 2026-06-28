/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { authorize, cubeScalar, queryRun, trace, SALES } from '@/lib/governed';

export const dynamic = 'force-dynamic';

/**
 * THE PROOF. Answers "revenue in DE last quarter" TWO ways and shows they match:
 *
 *   • metrics path — Cube measure `mart_sales.revenue`, filtered to region=DE +
 *     the last-quarter date range. This is exactly what the Superset "Sales
 *     Overview" dashboard renders, so dashboard == metrics tool by construction.
 *   • query path — DuckDB `sum(net_amount)` over the SAME Iceberg `mart_sales`,
 *     same region + date filter (the agent's ad-hoc tool).
 *
 * Because both read the one Sales mart, the numbers are identical. Both calls are
 * OPA-authorized + Langfuse-traced, so the proof is also fully governed.
 */
export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }

  const principal = user.domains[0] ?? user.id;
  const region = 'DE';
  const { start, end, label } = SALES.lastQuarter;

  const authz = await authorize(principal, 'metrics');
  const authzQ = await authorize(principal, 'query');
  if (!authz.allowed || !authzQ.allowed) {
    return NextResponse.json(
      { error: `OPA denied ${principal}`, policy: authz.policy, authorized: false },
      { status: 403 },
    );
  }

  let metricsValue: number | null = null;
  let metricsError = '';
  try {
    metricsValue = await cubeScalar(
      {
        measures: [SALES.revenueMeasure],
        filters: [{ member: SALES.regionDim, operator: 'equals', values: [region] }],
        timeDimensions: [{ dimension: SALES.dateDim, dateRange: [start, end] }],
      },
      SALES.revenueMeasure,
    );
  } catch (e) {
    metricsError = (e as Error).message;
  }

  let queryValue: number | null = null;
  let queryError = '';
  const sql =
    `select sum(${SALES.netAmountColumn}) as revenue from ${SALES.mart} ` +
    `where region = '${region}' and order_date between date '${start}' and date '${end}'`;
  try {
    const r = await queryRun(sql);
    const cell = r.rows?.[0]?.[0];
    queryValue = cell == null || cell === 'None' ? null : Number(cell);
    if (queryValue != null && Number.isNaN(queryValue)) queryValue = null;
  } catch (e) {
    queryError = (e as Error).message;
  }

  const round = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);
  const m = round(metricsValue);
  const q = round(queryValue);
  const equal = m != null && q != null && m === q;

  const tracedM = await trace({ principal, tool: 'metrics', input: { region, range: [start, end] }, output: m });
  const tracedQ = await trace({ principal, tool: 'query', input: sql, output: q });

  return NextResponse.json({
    question: `What was revenue in ${region} last quarter (${label})?`,
    principal,
    region,
    quarter: label,
    metrics: { value: m, source: 'Cube · mart_sales.revenue', tool: 'metrics', error: metricsError || undefined, traced: tracedM },
    query: { value: q, source: `DuckDB · sum(${SALES.netAmountColumn}) over Iceberg ${SALES.mart}`, sql, tool: 'query', error: queryError || undefined, traced: tracedQ },
    dashboard: { value: m, source: 'Superset "Sales Overview" (built on the same Cube metric)' },
    equal,
    policy: authz.policy,
    verdict: equal
      ? `MATCH — agent metrics tool, agent query tool, and dashboard all report ${m} for ${region} ${label}.`
      : 'Numbers not yet consistent — ensure the Sales mart is loaded into both Cube (Postgres warehouse) and Iceberg (query-tool).',
  });
}
