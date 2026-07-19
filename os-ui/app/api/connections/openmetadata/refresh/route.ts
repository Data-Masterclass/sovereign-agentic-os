/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/core/auth';
import { config } from '@/lib/core/config';
import { previewCatalogIngest, applyCatalogIngest } from '@/lib/connections/openmetadata-ingest';

export const dynamic = 'force-dynamic';

/**
 * #147 — the GOVERNED "refresh catalog" front door (scheduled + admin path).
 *
 * Folds the additive, integrity-safe metadata + DQ write-back over EVERY governed mart
 * the caller may see (DLS-scoped) so OpenMetadata reflects the live lakehouse in one
 * pass. This is the CronJob's target (it logs in as an admin service principal and POSTs
 * here — the SAME governed session a human uses; no bypass) AND the admin UI's manual
 * refresh. The parallel MCP `refresh_catalog` tool provides the human preview→approval
 * path; this route is the direct-apply path where the ADMIN role + the flag are the
 * governance boundary. All OM writes stay additive, namespace-scoped, managedBy-stamped
 * and version-fail-closed inside the orchestrator + the reused engines — an OM that is
 * down / out of range degrades to an honest no-op that never blocks.
 *
 *   GET  → dry-run PREVIEW across all governed marts (READ-ONLY, no writes).
 *   POST → APPLY the refresh (admin-gated; the route is the governance boundary).
 */
function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

function humanServiceFqnFrom(req: Request): string | undefined {
  const v = new URL(req.url).searchParams.get('humanServiceFqn');
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

export async function GET(req: Request) {
  try {
    const user = await requireAdmin();
    if (!config.openmetadataIngestEnabled) {
      return NextResponse.json({ error: 'Catalog ingestion is disabled (OPENMETADATA_INGEST_ENABLED is not true).' }, { status: 403 });
    }
    const preview = await previewCatalogIngest(user, { humanServiceFqn: humanServiceFqnFrom(req) });
    return NextResponse.json(preview);
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireAdmin();
    if (!config.openmetadataIngestEnabled) {
      return NextResponse.json({ error: 'Catalog ingestion is disabled (OPENMETADATA_INGEST_ENABLED is not true).' }, { status: 403 });
    }
    const result = await applyCatalogIngest(user, { humanServiceFqn: humanServiceFqnFrom(req) });
    // A partial failure (a real write error on some mart) is honest, not a 500 — return
    // the roll-up with ok:false so the caller/cron sees exactly what did (not) happen.
    return NextResponse.json(result, { status: result.ok ? 200 : 207 });
  } catch (e) {
    return fail(e);
  }
}
