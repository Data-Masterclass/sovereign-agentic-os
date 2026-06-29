/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * Structured-data catalog. Prefers OpenMetadata (the platform catalog + lineage)
 * when it's reachable; OpenMetadata is OFF by default locally (~2.5 GB JVM), so
 * we degrade gracefully to the governed query-tool's Iceberg table list (via
 * Trino `show tables`). The response says which source answered so the UI can be
 * honest about it.
 */

type Asset = { name: string; fqn: string; description: string; type: string };

async function fromOpenMetadata(): Promise<Asset[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(
      `${config.openmetadataApiUrl}/api/v1/tables?limit=50&fields=description`,
      { cache: 'no-store', signal: ctrl.signal, headers: { accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Record<string, unknown>[] };
    if (!Array.isArray(data?.data)) return null;
    return data.data.map((t) => ({
      name: String(t.name ?? ''),
      fqn: String(t.fullyQualifiedName ?? t.name ?? ''),
      description: String(t.description ?? ''),
      type: 'table',
    }));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fromQueryTool(): Promise<Asset[]> {
  const res = await fetch(`${config.queryToolUrl}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sql: 'show tables' }),
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`query-tool ${res.status}: ${text.slice(0, 160)}`);
  const data = JSON.parse(text);
  const schema = String(data?.schema ?? 'analytics');
  const rows: unknown[][] = Array.isArray(data?.rows) ? data.rows : [];
  return rows.map((r) => {
    const name = String(r[0]);
    return { name, fqn: `${schema}.${name}`, description: '', type: 'iceberg table' };
  });
}

export async function GET() {
  const om = await fromOpenMetadata();
  if (om) {
    return NextResponse.json({ source: 'openmetadata', assets: om });
  }
  try {
    const assets = await fromQueryTool();
    return NextResponse.json({
      source: 'query-tool',
      note: 'OpenMetadata is off or unreachable — showing the query-tool catalog.',
      assets,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `No catalog available: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
