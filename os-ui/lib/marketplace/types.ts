/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Internal cross-domain Marketplace — shared type surface.
 *
 * PURE TYPES + tiny helpers only (no `server-only`, no third-party imports) so
 * this file is importable by client components, server routes, AND the node:test
 * suite that runs without `node_modules`. The stateful store + the live adapters
 * (OpenMetadata / OpenSearch / Cube / OPA / Langfuse) live in `store.ts` and
 * `adapters.ts`, behind these interfaces.
 *
 * The unifying idea (marketplace-golden-path.md): **import = a governed grant**.
 * The owner's certified artifact stays the source of truth and is consumed under
 * the consumer's identity + RLS — except where a type needs its own
 * instance / creds / editable copy.
 */

import type { ArtifactType } from '@/lib/artifact-model';

/**
 * Product types listable in the marketplace. Reuses the artifact lifecycle types
 * (R2/R3 registry) and adds `app` for the Software tab (its own registry).
 */
export type ProductType = ArtifactType | 'app';

export const PRODUCT_TYPES: ProductType[] = [
  'dataset',
  'transformation',
  'metric',
  'dashboard',
  'agent',
  'knowledge',
  'connection',
  'file',
  'app',
];

export const PRODUCT_TYPE_LABELS: Record<ProductType, string> = {
  dataset: 'Data product',
  transformation: 'Transformation',
  metric: 'Metric',
  dashboard: 'Dashboard',
  agent: 'Agent',
  knowledge: 'Knowledge',
  connection: 'Connection',
  file: 'Files',
  skill: 'Skill',
  app: 'App',
};

/**
 * How a consumer imports a product. The default per type encodes the golden-path
 * table; `read-grant` is the default for every data-like product (single source,
 * consistent, RLS-scoped).
 *
 *  - `read-grant`      read-in-place via a policy-compiler grant (OPA/Cube/DLS), RLS per viewer.
 *  - `fork`            an editable copy the consumer owns (knowledge adapt, agent fork-to-own).
 *  - `deploy-instance` deploy your own instance (apps; shared-instance is a trusted option).
 *  - `template`        a connection template; bring your own creds (full-shared is a trusted option).
 */
export type ImportMode = 'read-grant' | 'fork' | 'deploy-instance' | 'template';

export const IMPORT_MODE_LABELS: Record<ImportMode, string> = {
  'read-grant': 'Read in place (governed grant)',
  fork: 'Fork to own (editable copy)',
  'deploy-instance': 'Deploy your own instance',
  template: 'Use as template (your own creds)',
};

/** Where the compiled grant is actually enforced (the policy-compiler target). */
export type EnforcementTarget = 'opa-trino' | 'cube-rls' | 'opensearch-dls' | 'instance' | 'template' | 'copy';

/** Whether importing is automatic or needs an owner/governance approval. */
export type AccessPolicy = 'open' | 'approval';

/** Certification / lifecycle state of a listing. */
export type ListingStatus = 'listed' | 'deprecated';

/**
 * A compiled row-level predicate (a tiny subset of SQL the offline-mock RLS
 * evaluator understands: `true`, or `field = 'value'`, joined by ` AND `).
 * In a live deployment this is what the policy compiler emits to Trino/OPA
 * (rowFilter) and Cube (securityContext) — see data-policy-compiler.md.
 */
export type RowPredicate = string;

/** The RLS scope a grant compiles to (rows + optional column projection). */
export type GrantScope = {
  rows: RowPredicate;
  columns?: string[];
};

/** Trust signals shown on a listing card so a consumer can judge before importing. */
export type TrustSignals = {
  certified: boolean;
  /** 0..1 freshness (1 = updated today). */
  freshness: number;
  /** 0..1 quality score (tests/profiling pass rate). */
  quality: number;
  /** Distinct consumer domains that have imported this product. */
  imports: number;
  /** Mean rating 0..5 (0 = unrated). */
  rating: number;
  ratingCount: number;
};

/** A node in a product's lineage graph (upstream sources / downstream importers). */
export type LineageNode = {
  id: string;
  name: string;
  type: ProductType | 'domain';
  relation: 'upstream' | 'importer';
  domain: string;
};

/** A marketplace listing — a certified product enriched with trust + import info. */
export type Listing = {
  id: string;
  /** The backing artifact / app-registry id (source of truth). */
  productId: string;
  type: ProductType;
  name: string;
  description: string;
  owner: string;
  ownerDomain: string;
  tags: string[];
  status: ListingStatus;
  accessPolicy: AccessPolicy;
  defaultMode: ImportMode;
  modeOptions: ImportMode[];
  trust: TrustSignals;
  updatedAt: string;
  /** Backing store: OpenMetadata /data-marketplace (data/metrics) or the OS registry. */
  registry: 'openmetadata' | 'os-registry';
};

/** A listing + the heavy detail (preview rows, lineage) loaded on demand. */
export type ListingDetail = Listing & {
  /** A small RLS-filtered sample so a consumer can preview before importing. */
  preview: PreviewSample;
  lineage: LineageNode[];
  /** Domains that have imported (owner-visible usage). */
  importers: ImportUsage[];
};

/** A preview sample, already RLS-filtered for the requesting viewer. */
export type PreviewSample = {
  kind: 'rows' | 'text' | 'spec';
  columns?: string[];
  rows?: string[][];
  text?: string;
  /** The RLS predicate that produced this sample, for transparency. */
  rlsApplied?: RowPredicate;
};

/** A governed grant created by an import (the heart of import=grant). */
export type Grant = {
  id: string;
  listingId: string;
  productId: string;
  type: ProductType;
  productName: string;
  mode: ImportMode;
  /** Consumer identity the artifact is consumed under. */
  granteeUser: string;
  granteeDomain: string;
  ownerUser: string;
  ownerDomain: string;
  scope: GrantScope;
  enforcedBy: EnforcementTarget;
  status: 'active' | 'pending' | 'revoked';
  /** Set when accessPolicy='approval': the governance approval that gates it. */
  approvalId?: string;
  /** For forks/instances/templates: the new artifact the consumer now owns. */
  derivedId?: string;
  createdAt: string;
  updatedAt: string;
};

/** A per-domain usage roll-up the owner sees. */
export type ImportUsage = {
  domain: string;
  user: string;
  mode: ImportMode;
  status: Grant['status'];
  at: string;
};

/** The result of an import call. */
export type ImportResult = {
  grant: Grant;
  /** True when the import is held pending a Governance approval. */
  pending: boolean;
  /** A human note for the UI (e.g. "Bring your own credentials"). */
  note?: string;
};

/** Result of a lineage-aware deprecate. */
export type DeprecateResult = {
  listingId: string;
  deprecated: boolean;
  /** Importer domains warned (they keep access; nothing is silently removed). */
  warned: string[];
};

/** A search/filter over the catalog. */
export type ListingFilter = {
  q?: string;
  type?: ProductType;
  domain?: string;
  tag?: string;
  includeDeprecated?: boolean;
};

// ----------------------------------------------------------- adapter contracts

/**
 * The three marketplace adapters. Each has a live implementation (OpenMetadata
 * `/data-marketplace` + the OS registry + the policy compiler) AND an
 * offline-mock that is authoritative with no cluster — the same dual pattern as
 * `lib/artifacts.ts`. `source()` reports which path served the request.
 */
export interface ListingAdapter {
  list(filter: ListingFilter): Promise<Listing[]>;
  get(listingId: string, viewer: Viewer): Promise<ListingDetail | null>;
  source(): AdapterSource;
}

export interface PublishAdapter {
  /** Admin certifies a product (in its own tab) → it gets listed here. */
  certify(productId: string, actor: Viewer): Promise<Listing>;
  /** Lineage-aware deprecate: importers are warned, never silently cut off. */
  deprecate(listingId: string, actor: Viewer): Promise<DeprecateResult>;
}

export interface ImportAdapter {
  /** Per-type import → a governed grant (read-in-place) / fork / instance / template. */
  import(listingId: string, viewer: Viewer, mode: ImportMode): Promise<ImportResult>;
}

export type AdapterSource = 'live' | 'offline-mock';

/** The consuming identity (a thin projection of CurrentUser). */
export type Viewer = {
  id: string;
  domains: string[];
  role: 'creator' | 'builder' | 'admin';
  /** The active domain the consumer imports into (defaults to domains[0]). */
  activeDomain?: string;
};

/** The domain a viewer is acting as (active override, else first domain). */
export function actingDomain(v: Viewer): string {
  if (v.activeDomain && v.domains.includes(v.activeDomain)) return v.activeDomain;
  return v.domains[0] ?? 'unknown';
}

export type { ArtifactType };
