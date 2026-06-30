/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * Metrics (semantic layer) -> Cube. Server-side we POST the canonical
 * `daily_revenue` query to Cube's REST load API and return the measures +
 * time dimension as a table, plus the resolved measure/dimension annotation
 * so the surface can describe the metric. No Cube URL or token reaches the
 * browser.
 */

const QUERY = {
  measures: ['daily_revenue.total_revenue', 'daily_revenue.total_orders'],
  timeDimensions: [{ dimension: 'daily_revenue.order_date', granularity: 'day' }],
  order: { 'daily_revenue.order_date': 'asc' },
  limit: 100,
};

type Annotated = { name: string; title: string; shortTitle?: string; type?: string };

function annoList(obj: Record<string, unknown> | undefined): Annotated[] {
  if (!obj) return [];
  return Object.entries(obj).map(([name, v]) => {
    const a = (v ?? {}) as Record<string, unknown>;
    return {
      name,
      title: String(a.title ?? name),
      shortTitle: a.shortTitle ? String(a.shortTitle) : undefined,
      type: a.type ? String(a.type) : undefined,
    };
  });
}

export async function GET() {
  const url = `${config.cubeUrl}/cubejs-api/v1/load`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: QUERY }),
      cache: 'no-store',
    });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { error: `Cube ${res.status}: ${text.slice(0, 300)}` },
        { status: 502 },
      );
    }
    const data = JSON.parse(text);
    const rawData: Record<string, unknown>[] = Array.isArray(data?.data) ? data.data : [];
    const annotation = (data?.annotation ?? {}) as Record<string, unknown>;
    const measures = annoList(annotation.measures as Record<string, unknown>);
    // Cube annotates a time dimension under both its base name and its
    // granularity-suffixed name (…order_date AND …order_date.day) with the same
    // label; dedupe by display label, keeping the granular (first) entry.
    const dedupe = (list: Annotated[]): Annotated[] => {
      const seen = new Set<string>();
      return list.filter((a) => {
        const label = a.shortTitle ?? a.title;
        if (seen.has(label)) return false;
        seen.add(label);
        return true;
      });
    };
    const timeDimensions = dedupe(annoList(annotation.timeDimensions as Record<string, unknown>));
    const dimensions = dedupe(annoList(annotation.dimensions as Record<string, unknown>));

    // Column order: time dimensions first, then measures.
    const columns = [...timeDimensions, ...dimensions, ...measures];
    const rows = rawData.map((r) => columns.map((c) => String(r[c.name] ?? '')));

    return NextResponse.json({
      cube: 'daily_revenue',
      measures,
      dimensions: [...timeDimensions, ...dimensions],
      columns: columns.map((c) => c.shortTitle ?? c.title),
      rows,
      rowCount: rows.length,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach Cube: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
