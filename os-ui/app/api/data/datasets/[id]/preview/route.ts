/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { getDataset, builtLayerFqn } from '@/lib/data/store';
import { queryRun } from '@/lib/infra/governed';
import { runPreview } from '@/lib/data/preview';
import type { Layer } from '@/lib/data/dataset-schema';

export const dynamic = 'force-dynamic';

/**
 * Governed ROW PREVIEW — "let me scan through a subset of the data." Runs a real
 * `SELECT * FROM <fqn> LIMIT n` through the SAME governed read path the profile and
 * NL→SQL surfaces use (`queryRun(sql, principal)`), so:
 *   • anonymous callers get 401 (requirePrincipal);
 *   • a non-viewer is refused by the registry's canView guard (403) before any SQL;
 *   • Trino's OPA plugin applies the caller's row filters + column masks to the rows —
 *     a masked column previews masked values, exactly like the agent/dashboard reads.
 *
 * The FQN is resolved SERVER-SIDE from the registry (tier-aware — personal lane for a
 * private dataset, domain schema for a governed asset/product), never from the request:
 * the caller only names the dataset id + a bounded limit. When the version isn't built,
 * or its physical table isn't materialized yet, the pure `runPreview` core answers with
 * a CALM `available:false` "build it first" state — never a raw `TABLE_NOT_FOUND`.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal(); // 401 for anon
    const { id } = await ctx.params;
    const dataset = getDataset(id, user); // 403 for a non-viewer (canView guard)

    const url = new URL(req.url);
    const requested = url.searchParams.get('layer') as Layer | null;
    const limit = url.searchParams.get('limit');

    // Resolve the physical table tier-aware (the SAME name the ask/query surface uses).
    // builtLayerFqn also returns the PRINCIPAL to read as: a private dataset lives in
    // the owner's personal_<uid> lane and must be read AS the owner (else Trino's OPA
    // plugin denies the columns); a governed asset is read as the caller's domain.
    const target = builtLayerFqn(dataset, user, requested ?? undefined);
    const principal = target?.principal ?? (user.domains[0] ?? user.id);

    const outcome = await runPreview({
      target,
      limit,
      query: (sql) => queryRun(sql, principal),
    });

    return NextResponse.json({ datasetId: id, name: dataset.name, ...outcome });
  } catch (e) {
    return errorResponse(e); // folds the tagged 401/403 (and any 4xx) into a response
  }
}
