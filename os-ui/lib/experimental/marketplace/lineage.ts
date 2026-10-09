/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Lineage-aware deprecation — pure helpers. "Decertify / deprecate is
 * lineage-aware: importers are warned; an in-use product can't be silently
 * removed" (marketplace-golden-path.md). The store calls these to decide the
 * warning set and to keep active grants alive after deprecation.
 */

import type { Grant, DeprecateResult, ProductType, LineageNode } from './types';

/** Active (or pending) importer domains for a listing — the warning set. */
export function importersOf(grants: Grant[], listingId: string): string[] {
  const domains = new Set<string>();
  for (const g of grants) {
    if (g.listingId === listingId && g.status !== 'revoked') domains.add(g.granteeDomain);
  }
  return [...domains].sort();
}

/**
 * Compute the result of deprecating a listing: it is marked deprecated and every
 * importer domain is warned. Grants are NOT revoked here (callers keep them
 * active) — the product can't be silently removed from under its consumers.
 */
export function planDeprecation(listingId: string, grants: Grant[]): DeprecateResult {
  return {
    listingId,
    deprecated: true,
    warned: importersOf(grants, listingId),
  };
}

/**
 * Build the downstream lineage (importer nodes) for a product from its grants.
 * Upstream nodes (the product's own sources) come from the registry/OpenMetadata
 * and are merged in by the adapter.
 */
export function importerLineage(
  grants: Grant[],
  listingId: string,
): LineageNode[] {
  const seen = new Set<string>();
  const nodes: LineageNode[] = [];
  for (const g of grants) {
    if (g.listingId !== listingId || g.status === 'revoked') continue;
    const key = `${g.granteeDomain}:${g.mode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nodes.push({
      id: `importer_${g.granteeDomain}`,
      name: `${g.granteeDomain} (${g.mode})`,
      type: 'domain',
      relation: 'importer',
      domain: g.granteeDomain,
    });
  }
  return nodes;
}

/** A product can be safely hard-removed only when nothing imports it. */
export function canHardRemove(grants: Grant[], listingId: string): boolean {
  return importersOf(grants, listingId).length === 0;
}

export type { ProductType };
