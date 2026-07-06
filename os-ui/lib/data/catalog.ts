/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { DatasetGroups } from './store.ts';
import { slug } from './store-fqn.ts';

/**
 * Catalog assembly — the PURE core behind /api/catalog, kept free of `server-only`
 * / Next imports so it is directly unit-testable.
 *
 * The catalog is an HONEST UNION of what ACTUALLY exists, labelled by source:
 *   • registry     — the governed dataset registry (always available, DLS-scoped to
 *                     the caller by the store; a missing warehouse never hides it).
 *   • trino        — physical Iceberg tables in the caller's OWN domain schema.
 *   • openmetadata  — the platform catalog, ONLY when a bot token is configured.
 *
 * The contract: a missing/empty warehouse or an unreachable/unauthenticated
 * OpenMetadata yields a valid registry-only-or-empty catalog with an honest
 * per-source status — NEVER a 500. Every asset carries its `source` so the UI is
 * truthful about where each entry came from.
 */

export type CatalogSource = 'registry' | 'trino' | 'openmetadata';

export type CatalogAsset = {
  name: string;
  fqn: string;
  description: string;
  type: string;
  source: CatalogSource;
  /** Populated for registry-sourced entries — enables the catalog to link to the
   *  dataset detail view without reversing the FQN. */
  datasetId?: string;
};

export type CatalogSourceStatus = {
  source: CatalogSource;
  ok: boolean;
  count: number;
  status: string;
};

export type CatalogResult = {
  source: 'union';
  sources: CatalogSourceStatus[];
  assets: CatalogAsset[];
};

/** Furthest built medallion layer for a summary, or null if nothing is built. */
function builtLayer(dots: { bronze: boolean; silver: boolean; gold: boolean }): 'gold' | 'silver' | 'bronze' | null {
  if (dots.gold) return 'gold';
  if (dots.silver) return 'silver';
  if (dots.bronze) return 'bronze';
  return null;
}

/**
 * Registry assets from a DLS-scoped {@link DatasetGroups}. The store already
 * clamps this to what the caller may see (owner + domain assets + marketplace
 * products), so the catalog inherits data-level security for free — a creator
 * only ever sees their own + shared datasets here.
 */
export function registryAssets(groups: DatasetGroups): CatalogAsset[] {
  const all = [...groups.mine, ...groups.domain, ...groups.marketplace];
  return all.map((d) => {
    const layer = builtLayer(d.dots);
    const tierLabel = d.tier === 'product' ? 'data product' : d.tier === 'asset' ? 'data asset' : 'dataset';
    // A built version has a governed Iceberg FQN; an un-materialized registry
    // dataset is still catalogued (honestly flagged) so it is discoverable.
    const fqn = layer ? `iceberg.${d.domain}.${layer}_${slug(d.name)}` : `registry:${d.id}`;
    const materialized = layer ? '' : ' · not materialized yet';
    return {
      name: d.name,
      fqn,
      description: `${tierLabel} · ${d.domain}${materialized}`,
      type: tierLabel,
      source: 'registry' as const,
      datasetId: d.id,
    };
  });
}

/** Classify a query-tool/Trino error into an honest, non-alarming source status. */
export function trinoStatus(err: unknown, schema: string): string {
  const msg = (err as Error)?.message ?? String(err);
  if (/SCHEMA_NOT_FOUND|does not exist|NoSuchBucket|TABLE_NOT_FOUND/i.test(msg)) {
    return `physical marts not materialized yet (iceberg.${schema})`;
  }
  return `warehouse unreachable — ${msg.slice(0, 120)}`;
}

/**
 * Assemble the union. Each source is injected (fetchers) so this stays pure and
 * testable. Trino + OpenMetadata failures are ABSORBED into a source status; only
 * the always-available registry is required, so the result is never a 500.
 */
export async function assembleCatalog(opts: {
  schema: string;
  registry: CatalogAsset[];
  trino: () => Promise<CatalogAsset[]>;
  openmetadata: () => Promise<{ assets: CatalogAsset[] | null; status: string }>;
}): Promise<CatalogResult> {
  const assets: CatalogAsset[] = [];
  const sources: CatalogSourceStatus[] = [];

  // 1. registry — always available (in-process, DLS-scoped).
  assets.push(...opts.registry);
  sources.push({
    source: 'registry',
    ok: true,
    count: opts.registry.length,
    status: opts.registry.length ? 'governed dataset registry' : 'no datasets registered yet',
  });

  // 2. trino — physical tables in the caller's own domain schema.
  try {
    const t = await opts.trino();
    assets.push(...t);
    sources.push({
      source: 'trino',
      ok: true,
      count: t.length,
      status: t.length ? `physical tables in iceberg.${opts.schema}` : `no physical marts in iceberg.${opts.schema} yet`,
    });
  } catch (e) {
    sources.push({ source: 'trino', ok: false, count: 0, status: trinoStatus(e, opts.schema) });
  }

  // 3. openmetadata — only when a bot token is configured (else skipped honestly).
  const om = await opts.openmetadata();
  if (om.assets) {
    assets.push(...om.assets);
    sources.push({ source: 'openmetadata', ok: true, count: om.assets.length, status: om.status });
  } else {
    sources.push({ source: 'openmetadata', ok: false, count: 0, status: om.status });
  }

  return { source: 'union', sources, assets };
}
