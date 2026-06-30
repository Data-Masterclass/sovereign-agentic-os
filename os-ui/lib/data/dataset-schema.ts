/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import yaml from 'js-yaml';
import type { Role } from '../session.ts';

/**
 * `dataset.yaml` — the SINGLE source of truth for one logical dataset (Data tab).
 * It mirrors the Agents tab's `system.yaml` (Approach A): the guided panels, the
 * "Show the code" Monaco view and the data agent all edit THIS file (plus the
 * tool-native files it points at), so there is no lossy abstraction.
 *
 * The model (data-architecture-model.md) is two orthogonal axes:
 *   - refinement LAYER:  bronze -> silver -> gold      (the medallion versions)
 *   - sharing TIER:      dataset -> asset -> product   (the overall sharing state)
 * One dataset is ONE tile with three versions of itself; `tier` is its sharing
 * state, moved by promote/certify. `grants` is the ONE policy source the compiler
 * (data-policy-compiler.md) turns into Trino-OPA + Cube policies.
 *
 * Pure module — no server-only / network imports — so the store, the policy
 * compiler, the panels and the tests all share it. SHAPE validation only.
 */

export type Layer = 'bronze' | 'silver' | 'gold';
export type Tier = 'dataset' | 'asset' | 'product';
/** Visibility broadens with tier; authored once, compiled to OPA + Cube. */
export type DataVisibility = 'private' | 'domain' | 'shared' | 'public';
export type Quality = 'unknown' | 'passing' | 'failing';

export const LAYERS: Layer[] = ['bronze', 'silver', 'gold'];
export const TIERS: Tier[] = ['dataset', 'asset', 'product'];
const VISIBILITIES: DataVisibility[] = ['private', 'domain', 'shared', 'public'];
const QUALITIES: Quality[] = ['unknown', 'passing', 'failing'];

/** One medallion version of the dataset. `passThrough` carries the prior layer
 *  forward unchanged (data-ui-ux.md "Pass-through"). `artifact` is the path of the
 *  tool-native file (dlt/dbt/cube) so dual-mode editing always hits the real file. */
export type VersionState = {
  built: boolean;
  passThrough: boolean;
  quality: Quality;
  updatedAt: string | null;
  artifact: string | null;
};

export type Versions = { bronze: VersionState; silver: VersionState; gold: VersionState };

/** R1 (data-policy-compiler.md): every grant predicate is tagged with the
 *  cardinality of its attribute so the compiler knows whether to encode it as a
 *  Trino group (low) or an entitlement-table join (high). */
export type Cardinality = 'low' | 'high';

export type GrantScope = {
  /** WHERE-clause predicates, e.g. `region = $region` or `status <> 'draft'`. */
  rows: string[];
  /** Columns hidden (absent) or masked (obfuscated) for this grantee. */
  columns: { mask: string[]; hide: string[] };
};

export type Grantee = { kind: 'user' | 'group' | 'domain' | 'role'; id: string };

export type Grant = {
  grantee: Grantee;
  scope: GrantScope;
  cardinality: Cardinality;
  action: 'read';
};

/** A metric defined on the GOLD version — the Cube handover. The user only names
 *  the measure; `cube_dbt` scaffolds dimensions from the gold manifest. */
export type Measure = { name: string; type: string; sql: string };

/** A documented column (the documentation form). At least one with a non-empty
 *  description is required by the transparency gate before a dataset can promote. */
export type ColumnDoc = { name: string; description: string };

/** The OpenMetadata **Certification** trust badge on a Data Product. NOTE: its
 *  Bronze/Silver/Gold levels are a *trust* axis — deliberately DIFFERENT from the
 *  medallion *refinement* layer (data-architecture-model.md §Naming caution). */
export type TrustLevel = 'bronze' | 'silver' | 'gold';
export type Certification = { level: TrustLevel; by: string; at: string };
export const TRUST_LEVELS: TrustLevel[] = ['bronze', 'silver', 'gold'];

export type Dataset = {
  version: string;
  id: string;
  name: string;
  owner: string;
  domain: string;
  tier: Tier;
  visibility: DataVisibility;
  description: string;
  versions: Versions;
  grants: Grant[];
  measures: Measure[];
  /** Column-level documentation (transparency gate input). */
  columns: ColumnDoc[];
  /** OM certification badge — set on certify (product), cleared on decertify. */
  certification?: Certification;
  /** Domains that have imported/subscribed to this product (lineage-aware: a
   *  product with importers can't be decertified without orphaning them). */
  imports?: string[];
};

export class DatasetError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'DatasetError';
    this.status = status;
  }
}

// ----------------------------------------------------------- hard storage line --

export type Storage = 'duckdb-sandbox' | 'trino-iceberg';

/**
 * THE HARD STORAGE LINE (data-architecture-model.md): private datasets live in the
 * per-user DuckDB sandbox; only promoted assets and certified products live in
 * Trino/Iceberg. This single function is the one place that line is drawn.
 */
export function storageFor(tier: Tier): Storage {
  return tier === 'dataset' ? 'duckdb-sandbox' : 'trino-iceberg';
}

// --------------------------------------------------------- role-gated lifecycle --

export type Transition = 'promote' | 'certify' | 'unshare' | 'decertify';

const TIER_ORDER: Record<Tier, number> = { dataset: 0, asset: 1, product: 2 };

/** The forward/back tier move for a transition (no-op-safe). */
export function tierAfter(tier: Tier, t: Transition): Tier {
  switch (t) {
    case 'promote':
      return 'asset';
    case 'certify':
      return 'product';
    case 'unshare':
      return 'dataset';
    case 'decertify':
      return 'asset';
  }
}

/**
 * Separation of duties (data-architecture-model.md roles table). Personas map onto
 * the platform `Role`: `participant` = Creator (datasets only), `builder` promotes
 * dataset->asset, `admin` certifies asset->product. Reverse moves match the gate of
 * the forward move they undo.
 */
export function canTransition(role: Role, from: Tier, t: Transition): { ok: boolean; reason?: string } {
  const to = tierAfter(from, t);
  // The transition must actually be a legal single step on the lifecycle line.
  const legal =
    (t === 'promote' && from === 'dataset') ||
    (t === 'certify' && from === 'asset') ||
    (t === 'unshare' && from === 'asset') ||
    (t === 'decertify' && from === 'product');
  if (!legal) return { ok: false, reason: `cannot ${t} from a ${from}` };

  const needsBuilder = t === 'promote' || t === 'unshare';
  const needsAdmin = t === 'certify' || t === 'decertify';
  if (needsAdmin && role !== 'admin') {
    return { ok: false, reason: `${t} (${from}→${to}) requires Admin` };
  }
  if (needsBuilder && role !== 'builder' && role !== 'admin') {
    return { ok: false, reason: `${t} (${from}→${to}) requires Builder` };
  }
  return { ok: true };
}

/** Visibility a tier is allowed to reach (datasets are always private). */
export function visibilityFor(tier: Tier, requested: DataVisibility): DataVisibility {
  if (tier === 'dataset') return 'private';
  if (tier === 'asset') return requested === 'public' ? 'shared' : requested === 'private' ? 'domain' : requested;
  return requested === 'private' ? 'domain' : requested; // product is at least domain-visible
}

// -------------------------------------------------------------------- parsing --

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strArray(v: unknown, where: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new DatasetError(`dataset.yaml: '${where}' must be a list`);
  return v.map((x) => String(x));
}

function parseVersion(v: unknown): VersionState {
  const r = isRecord(v) ? v : {};
  const quality = (r.quality ?? 'unknown') as Quality;
  return {
    built: Boolean(r.built),
    passThrough: Boolean(r.passThrough),
    quality: QUALITIES.includes(quality) ? quality : 'unknown',
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : null,
    artifact: typeof r.artifact === 'string' ? r.artifact : null,
  };
}

function parseVersions(v: unknown): Versions {
  const r = isRecord(v) ? v : {};
  return { bronze: parseVersion(r.bronze), silver: parseVersion(r.silver), gold: parseVersion(r.gold) };
}

function parseGrant(raw: unknown, i: number): Grant {
  if (!isRecord(raw)) throw new DatasetError(`dataset.yaml: grants[${i}] must be a mapping`);
  const g = isRecord(raw.grantee) ? raw.grantee : {};
  const kind = g.kind as Grantee['kind'];
  if (!['user', 'group', 'domain', 'role'].includes(kind)) {
    throw new DatasetError(`dataset.yaml: grants[${i}].grantee.kind invalid (user|group|domain|role)`);
  }
  if (typeof g.id !== 'string' || g.id.length === 0) {
    throw new DatasetError(`dataset.yaml: grants[${i}].grantee.id required`);
  }
  const scopeRaw = isRecord(raw.scope) ? raw.scope : {};
  const colsRaw = isRecord(scopeRaw.columns) ? scopeRaw.columns : {};
  const cardinality = (raw.cardinality ?? 'low') as Cardinality;
  return {
    grantee: { kind, id: g.id },
    scope: {
      rows: strArray(scopeRaw.rows, `grants[${i}].scope.rows`),
      columns: {
        mask: strArray(colsRaw.mask, `grants[${i}].scope.columns.mask`),
        hide: strArray(colsRaw.hide, `grants[${i}].scope.columns.hide`),
      },
    },
    cardinality: cardinality === 'high' ? 'high' : 'low',
    action: 'read',
  };
}

function parseMeasure(raw: unknown, i: number): Measure {
  if (!isRecord(raw) || typeof raw.name !== 'string') {
    throw new DatasetError(`dataset.yaml: measures[${i}] needs a string 'name'`);
  }
  return { name: raw.name, type: typeof raw.type === 'string' ? raw.type : 'count', sql: typeof raw.sql === 'string' ? raw.sql : '' };
}

function parseColumn(raw: unknown, i: number): ColumnDoc {
  if (!isRecord(raw) || typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new DatasetError(`dataset.yaml: columns[${i}] needs a string 'name'`);
  }
  return { name: raw.name, description: typeof raw.description === 'string' ? raw.description : '' };
}

export function parseDataset(input: string | Record<string, unknown>): Dataset {
  let doc: unknown;
  if (typeof input === 'string') {
    try {
      doc = yaml.load(input);
    } catch (e) {
      throw new DatasetError(`dataset.yaml: not valid YAML — ${(e as Error).message}`);
    }
  } else {
    doc = input;
  }
  if (!isRecord(doc)) throw new DatasetError('dataset.yaml: expected a mapping at the document root');

  const tier = (doc.tier ?? 'dataset') as Tier;
  if (!TIERS.includes(tier)) throw new DatasetError(`dataset.yaml: tier '${String(doc.tier)}' invalid (${TIERS.join('|')})`);
  const visRaw = (doc.visibility ?? 'private') as DataVisibility;
  if (!VISIBILITIES.includes(visRaw)) {
    throw new DatasetError(`dataset.yaml: visibility '${String(doc.visibility)}' invalid (${VISIBILITIES.join('|')})`);
  }

  const grantsRaw = Array.isArray(doc.grants) ? doc.grants : [];
  const measuresRaw = Array.isArray(doc.measures) ? doc.measures : [];
  const columnsRaw = Array.isArray(doc.columns) ? doc.columns : [];

  let certification: Certification | undefined;
  if (isRecord(doc.certification) && TRUST_LEVELS.includes(doc.certification.level as TrustLevel)) {
    const c = doc.certification;
    certification = { level: c.level as TrustLevel, by: String(c.by ?? ''), at: String(c.at ?? '') };
  }
  const imports = Array.isArray(doc.imports) ? doc.imports.map((x) => String(x)) : undefined;

  return {
    version: doc.version !== undefined ? String(doc.version) : '1',
    id: typeof doc.id === 'string' ? doc.id : '',
    name: typeof doc.name === 'string' ? doc.name : 'Untitled dataset',
    owner: typeof doc.owner === 'string' ? doc.owner : '',
    domain: typeof doc.domain === 'string' ? doc.domain : '',
    tier,
    // A dataset is always private; tier+visibility are kept consistent on parse.
    visibility: visibilityFor(tier, visRaw),
    description: typeof doc.description === 'string' ? doc.description : '',
    versions: parseVersions(doc.versions),
    grants: grantsRaw.map(parseGrant),
    measures: measuresRaw.map(parseMeasure),
    columns: columnsRaw.map(parseColumn),
    ...(certification ? { certification } : {}),
    ...(imports ? { imports } : {}),
  };
}

export function serializeDataset(d: Dataset): string {
  const doc: Record<string, unknown> = {
    version: d.version,
    id: d.id,
    name: d.name,
    owner: d.owner,
    domain: d.domain,
    tier: d.tier,
    visibility: d.visibility,
  };
  if (d.description) doc.description = d.description;
  doc.versions = d.versions;
  if (d.grants.length > 0) doc.grants = d.grants;
  if (d.measures.length > 0) doc.measures = d.measures;
  if (d.columns.length > 0) doc.columns = d.columns;
  if (d.certification) doc.certification = d.certification;
  if (d.imports && d.imports.length > 0) doc.imports = d.imports;
  return yaml.dump(doc, { lineWidth: 100, noRefs: true });
}

/** A fresh empty version (nothing built yet). */
export function emptyVersion(): VersionState {
  return { built: false, passThrough: false, quality: 'unknown', updatedAt: null, artifact: null };
}

export function emptyVersions(): Versions {
  return { bronze: emptyVersion(), silver: emptyVersion(), gold: emptyVersion() };
}
