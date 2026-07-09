/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { authorize, cubeScalar, queryRun, trace, SALES } from '@/lib/infra/governed';

export const dynamic = 'force-dynamic';

/**
 * The Sales agent (stage 6 of the golden path). It routes a plain-language
 * question to ONE of the two governed tools and answers with a number:
 *
 *   • KPI questions ("revenue/orders in DE last quarter") -> the Cube `metrics`
 *     tool — the SAME canonical metric the dashboard uses.
 *   • ad-hoc questions ("net_amount / breakdown / which product…") -> the
 *     `query` tool — DuckDB over the SAME Iceberg `mart_sales`.
 *
 * Routing is deterministic (so it works against the offline mock model and the
 * validation is repeatable); both branches are OPA-authorized + Langfuse-traced.
 */

const REGIONS = ['DE', 'FR', 'US'];

function detectRegion(q: string): string | null {
  const up = q.toUpperCase();
  for (const r of REGIONS) {
    if (new RegExp(`\\b${r}\\b`).test(up)) return r;
  }
  if (/germany|deutschland/i.test(q)) return 'DE';
  if (/france/i.test(q)) return 'FR';
  if (/\bunited states|\bus\b|america/i.test(q)) return 'US';
  return null;
}

export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }
  let question = '';
  try {
    const body = await req.json();
    question = (body?.question ?? '').toString().trim();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!question) return NextResponse.json({ error: 'Ask a question' }, { status: 400 });

  const principal = user.domains[0] ?? user.id;
  const region = detectRegion(question);
  const { start, end, label } = SALES.lastQuarter;

  // Route: ad-hoc/SQL-ish signals -> query tool; KPI signals -> metrics tool.
  const adHoc = /\b(breakdown|by product|which|list|rows?|raw|net_amount|sum|table|top|per region|by region)\b/i.test(question);
  const kpi = /\b(revenue|orders|aov|kpi|metric|total|how much)\b/i.test(question);
  const tool: 'metrics' | 'query' = adHoc || !kpi ? 'query' : 'metrics';

  const authz = await authorize(principal, tool);
  if (!authz.allowed) {
    return NextResponse.json({ error: `OPA denied ${principal} → ${tool}`, authorized: false }, { status: 403 });
  }

  try {
    if (tool === 'metrics') {
      const measure = /orders/i.test(question) ? 'mart_sales.orders' : SALES.revenueMeasure;
      const filters = region ? [{ member: SALES.regionDim, operator: 'equals', values: [region] }] : [];
      const value = await cubeScalar(
        { measures: [measure], filters, timeDimensions: [{ dimension: SALES.dateDim, dateRange: [start, end] }] },
        measure,
      );
      const traced = await trace({ principal, tool, input: { measure, region, range: [start, end] }, output: value });
      const label2 = measure.endsWith('orders') ? 'orders' : 'revenue';
      const answer =
        value == null
          ? `No ${label2} found for ${region ?? 'all regions'} in ${label}.`
          : `${region ?? 'All regions'} ${label2} for ${label} was ${value} (via the Cube metrics tool — the same metric the Sales Overview dashboard uses).`;
      return NextResponse.json({ tool, principal, authorized: true, policy: authz.policy, traced, value, region, quarter: label, measure, answer });
    }

    // query tool — ad-hoc SQL over the Iceberg mart.
    let sql: string;
    if (/by product|breakdown|top|which/i.test(question)) {
      sql =
        `select product, sum(${SALES.netAmountColumn}) as revenue from ${SALES.mart} ` +
        (region ? `where region = '${region}' ` : '') +
        `group by product order by revenue desc`;
    } else {
      const where = region
        ? `where region = '${region}' and order_date between date '${start}' and date '${end}'`
        : `where order_date between date '${start}' and date '${end}'`;
      sql = `select sum(${SALES.netAmountColumn}) as revenue from ${SALES.mart} ${where}`;
    }
    const r = await queryRun(sql);
    const traced = await trace({ principal, tool, input: sql, output: r.rows });
    const scalar = r.rows.length === 1 && r.columns.length === 1 ? r.rows[0][0] : null;
    const answer = scalar != null
      ? `${region ?? 'All regions'} ${r.columns[0]} = ${scalar} (via the governed query tool over the Iceberg ${SALES.mart} — same data as the dashboard).`
      : `Ran the query tool over ${SALES.mart}; ${r.rowCount} row(s) returned.`;
    return NextResponse.json({ tool, principal, authorized: true, policy: authz.policy, traced, value: scalar != null ? Number(scalar) : null, region, sql, columns: r.columns, rows: r.rows, answer });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
