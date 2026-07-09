/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { getDataset } from '@/lib/data/store';
import { builtLayerFqn } from '@/lib/data/store';
import { queryRun } from '@/lib/infra/governed';
import type { Layer } from '@/lib/data/dataset-schema';
import {
  assembleProfile,
  parseDescribe,
  previewSql,
  statsSql,
  topValuesSql,
  type Profile,
  type ProfileColumn,
} from '@/lib/data/profile';

export const dynamic = 'force-dynamic';

const LAYERS: Layer[] = ['bronze', 'silver', 'gold'];
// Cap the top-values fan-out (one table scan per column) so a very wide table
// stays cheap — stats + preview always run; top values just degrade to empty.
const MAX_TOPVALUE_COLUMNS = 40;

/** Per-version profile cache — cheap, in-process, keyed on the version's own
 *  updatedAt so a rebuild invalidates it automatically. Survives HMR via a global
 *  symbol (mirrors the store's global-cache pattern). Re-open is instant; `?refresh=1`
 *  forces a recompute. */
type CacheState = { map: Map<string, Profile> };
const CACHE_KEY = Symbol.for('soa.data.profileCache');
function cache(): Map<string, Profile> {
  const g = globalThis as unknown as Record<symbol, CacheState | undefined>;
  if (!g[CACHE_KEY]) g[CACHE_KEY] = { map: new Map() };
  return g[CACHE_KEY]!.map;
}

/**
 * Profile ONE built medallion version of a dataset (Explore stage). The profiling
 * SQL is GENERATED here and run through the SAME governed `queryRun` an agent/panel
 * uses, so the caller's principal reaches Trino's OPA plugin: a user without view
 * rights is refused by the registry (403) before any SQL, and a user with column
 * masks sees masked stats — masking is preserved because we never touch Trino
 * directly. Anonymous callers get 401 (requirePrincipal).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal(); // 401 for anon
    const { id } = await ctx.params;
    const dataset = getDataset(id, user); // 403 for a non-viewer (canView guard)

    const url = new URL(req.url);
    const requested = url.searchParams.get('layer') as Layer | null;
    const refresh = url.searchParams.get('refresh') === '1';

    // The layer to profile: an explicit built layer, else the furthest built one.
    const built = LAYERS.filter((l) => dataset.versions[l].built);
    const layer = requested && built.includes(requested) ? requested : built[built.length - 1];
    if (!layer) {
      return NextResponse.json({
        datasetId: id,
        name: dataset.name,
        available: false,
        reason: 'Nothing built yet — bring in a Bronze version first.',
      });
    }

    // Tier-aware: a private dataset lives in the owner's personal_<uid> lane (read AS
    // the owner); a governed asset in its (sanitized) domain schema. Same resolver as
    // the preview surface — fixes both the personal PERMISSION_DENIED and a hyphenated
    // domain SYNTAX_ERROR (domainSchema normalizes it).
    const resolved = builtLayerFqn(dataset, user, layer);
    const fqn = resolved?.fqn ?? '';
    const stamp = dataset.versions[layer].updatedAt ?? dataset.version;
    const key = `${id}:${layer}:${stamp}`;

    if (!refresh) {
      const hit = cache().get(key);
      if (hit) return NextResponse.json({ datasetId: id, name: dataset.name, available: true, cached: true, ...hit });
    }

    // The principal Trino's OPA plugin governs row/column on — the OWNER for a personal
    // dataset (personal_<uid> ownership), else the caller's domain. NEVER from the body.
    const principal = resolved?.principal ?? (user.domains[0] ?? user.id);

    let columns: ProfileColumn[];
    try {
      const describe = await queryRun(`describe ${fqn}`, principal);
      columns = parseDescribe(describe);
    } catch (e) {
      // The registry knows this version, but its physical table isn't queryable
      // yet (not materialised, or wiped). Answer calmly rather than 5xx.
      return NextResponse.json({
        datasetId: id,
        name: dataset.name,
        layer,
        fqn,
        available: false,
        reason: `This ${layer} version isn't queryable yet (${(e as Error).message}).`,
      });
    }

    const statsRes = await queryRun(statsSql(fqn, columns), principal);
    const previewRes = await queryRun(previewSql(fqn, 50), principal);
    // Top values are best-effort: a wide table or a heavy scan must not fail the
    // whole profile (the count + null% acceptance rides on stats/preview).
    let topRes = null;
    if (columns.length > 0 && columns.length <= MAX_TOPVALUE_COLUMNS) {
      const sql = topValuesSql(fqn, columns, 5);
      if (sql) {
        try {
          topRes = await queryRun(sql, principal);
        } catch {
          topRes = null;
        }
      }
    }

    const profile = assembleProfile({ fqn, layer, columns, statsRes, topRes, previewRes });
    cache().set(key, profile);
    return NextResponse.json({ datasetId: id, name: dataset.name, available: true, cached: false, ...profile });
  } catch (e) {
    return errorResponse(e); // folds the tagged 401/403 (and any 4xx) into a response
  }
}
