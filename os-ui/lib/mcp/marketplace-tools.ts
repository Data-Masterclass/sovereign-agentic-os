/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/auth';
import type { McpTool, JsonSchema } from './server';

// --- The EXACT governed marketplace lib the UI + /api/marketplace call ---------
import { listingAdapter, rateListing } from '@/lib/marketplace';
import { grantsForUser } from '@/lib/marketplace/store';
import type { ProductType, ImportMode, Viewer } from '@/lib/marketplace/types';

/**
 * THE MARKETPLACE MCP SURFACE (mcp-v2 P3). Thin wrappers over the SAME governed
 * marketplace adapters the Marketplace tab calls, under the caller's identity. The
 * catalogue is the certified cross-domain products; consuming SHARED assets is a
 * creator right (nav labels the tab Builder/Admin, but browse/get/rate floor at
 * creator to match the lib gate + the "creators consume shared assets" invariant —
 * import_product [P0] still re-gates fork/instance/template to Builder+ in-lib).
 *
 * `get_listing`'s preview is RLS-filtered for the caller by the adapter (the
 * "different rows for different viewers" proof) — no privileged side-channel.
 */

const PRODUCT_TYPES: ProductType[] = ['dataset', 'metric', 'dashboard', 'knowledge', 'agent', 'connection', 'app'];

function fail(message: string, status: number): never {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  throw e;
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The caller as a marketplace Viewer (id + domains + role). */
function viewerOf(u: CurrentUser): Viewer {
  return { id: u.id, domains: u.domains, role: u.role };
}

const NO_ARGS: JsonSchema = { type: 'object', properties: {}, examples: [{}] };

export const marketplaceReadTools: McpTool[] = [
  {
    name: 'browse_marketplace',
    tab: 'marketplace',
    minRole: 'creator',
    description:
      'Browse the CERTIFIED cross-domain marketplace catalogue — the products another domain has vouched for and published (datasets, metrics, dashboards, knowledge, models, agents, apps). Filter by free-text `q`, `type`, owning `domain`, or `tag`. Purpose: step 1 of reuse — find a governed product to import instead of rebuilding. Before: whoami. After: get_listing for one product’s detail + lineage, then import_product to reuse it as a governed grant. Governance: read-only; the catalogue is the certified surface (consuming shared assets is a creator right).',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Free-text search over name/description/tags.' },
        type: { type: 'string', enum: PRODUCT_TYPES, description: 'Filter by product type.' },
        domain: { type: 'string', description: 'Filter by owning domain.' },
        tag: { type: 'string', description: 'Filter by tag.' },
      },
      examples: [{ q: 'revenue' }, { type: 'dataset', domain: 'sales' }],
    },
    call: async (_user, args) =>
      listingAdapter.list({
        q: str(args.q) || undefined,
        type: (str(args.type) as ProductType) || undefined,
        domain: str(args.domain) || undefined,
        tag: str(args.tag) || undefined,
      }),
  },
  {
    name: 'get_listing',
    tab: 'marketplace',
    minRole: 'creator',
    description:
      'Read ONE marketplace listing: its detail + trust signals (certified, imports, rating), a RLS-FILTERED preview (rows are scoped to YOUR domain — the "different rows for different viewers" proof), its lineage (upstream sources + importer domains), and the grants YOU already hold on it. Purpose: decide whether + how to reuse a product before importing. Before: browse_marketplace. After: import_product (grant-now or pending) or rate_listing. Governance: read-only; the preview never leaks rows outside your entitlement; an unknown id is a typed not_found.',
    inputSchema: {
      type: 'object',
      properties: { listingId: { type: 'string', description: 'Listing id from browse_marketplace.' } },
      required: ['listingId'],
      examples: [{ listingId: 'lst_ab12cd' }],
    },
    call: async (user, args) => {
      const listingId = str(args.listingId).trim();
      if (!listingId) fail('get_listing needs a `listingId` (from browse_marketplace)', 400);
      const detail = await listingAdapter.get(listingId, viewerOf(user));
      if (!detail) fail(`Listing not found: ${listingId}`, 404); // unknown == not visible (no leak)
      // The grants THIS caller already holds on this listing (their reuse history).
      const myGrants = grantsForUser(user.id).filter((g) => g.listingId === listingId);
      return { ...detail, myGrants, source: listingAdapter.source() };
    },
  },
];

export const marketplaceWriteTools: McpTool[] = [
  {
    name: 'rate_listing',
    tab: 'marketplace',
    minRole: 'creator',
    description:
      'Rate a marketplace listing 1–5 stars (an upsert — your latest rating replaces your previous one). Purpose: signal quality/trust back to the catalogue so others can find the good products. Before: get_listing (evaluate it first). After: browse_marketplace shows the updated aggregate rating. Governance: runs AS you and is audited; the aggregate is recomputed from all raters.',
    inputSchema: {
      type: 'object',
      properties: {
        listingId: { type: 'string', description: 'Listing id from browse_marketplace.' },
        stars: { type: 'number', description: 'A rating from 1 to 5.' },
      },
      required: ['listingId', 'stars'],
      examples: [{ listingId: 'lst_ab12cd', stars: 5 }],
    },
    call: async (user, args) => {
      const listingId = str(args.listingId).trim();
      if (!listingId) fail('rate_listing needs a `listingId`', 400);
      const stars = Math.round(Number(args.stars));
      if (!Number.isFinite(stars) || stars < 1 || stars > 5) fail('rate_listing needs `stars` = 1..5', 400);
      const agg = rateListing(listingId, viewerOf(user), stars);
      return { listingId, yourRating: stars, ...agg };
    },
  },
];

export const MARKETPLACE_TOOLS: McpTool[] = [...marketplaceReadTools, ...marketplaceWriteTools];

// Keep ImportMode referenced (import_product [P0] carries the modes; this surface
// documents them in browse/get flow without re-declaring the enum).
export type MarketplaceImportMode = ImportMode;
