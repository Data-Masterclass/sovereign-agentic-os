/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import yaml from 'js-yaml';
import { roleAtLeast } from '../core/session.ts';
import type { Role } from '../core/session.ts';
import { normaliseFolderPath } from '../core/folders.ts';
import { isValidCron } from '../agents/cron-util.ts';

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

/** A conditional filter applied to a measure's aggregation (Cube `filters:`). The
 *  `sql` is a boolean predicate on the cube, e.g. `{CUBE}.status = 'completed'`. */
export type MeasureFilter = { sql: string };

/** A moving time window for a measure (Cube `rolling_window:`). `trailing`/`leading`
 *  are durations like `7 day`, `1 month`, or `unbounded`; `offset` anchors the window
 *  (`start`|`end`). A cumulative/running total is `{ trailing: 'unbounded' }`. */
export type RollingWindow = { trailing?: string; leading?: string; offset?: 'start' | 'end' };

/** A metric defined on the GOLD version — the Cube handover. The user only names
 *  the measure; `cube_dbt` scaffolds dimensions from the gold manifest. The four
 *  optional fields expose the richer Cube measure model (filters / rolling windows /
 *  display format / drill-down members); they are ABSENT on a plain measure so every
 *  existing consumer (parse, serialize, scaffoldCubeYaml, sameMeasure) is unchanged. */
export type Measure = {
  name: string;
  type: string;
  sql: string;
  /** DISPLAY name shown wherever the metric's name appears. A metric IS `dataset.measure`,
   *  so its physical identity is the Cube member `${View}.${name}` — renaming a metric must
   *  NEVER move that member. So a rename writes THIS label (falls back to `name` when unset)
   *  and freezes `name`, exactly as a dataset rename freezes its physical slug. */
  label?: string;
  /** Conditional filters narrowing what the aggregation counts (Cube `filters:`). */
  filters?: MeasureFilter[];
  /** A moving time window — trailing/leading/running total (Cube `rolling_window:`). */
  rollingWindow?: RollingWindow;
  /** Display format — `percent`, `currency`, `number`, … (Cube `format:`). */
  format?: string;
  /** Drill-down members exposed for exploration (Cube `drill_members:`). */
  drillMembers?: string[];
  /** COMPOSITE metric only: the SOURCE formula the user wrote (`([revenue]-[cost])/[orders]`).
   *  `sql` holds its compiled `{measure}`-reference form; this round-trips the human-readable
   *  original for Edit/View. Absent on every non-formula measure. */
  formula?: string;
  /** A plain-language sentence — "what does this metric mean?" — shown in the View
   *  Definition panel and on the metric tile. Absent on every measure created before this
   *  field existed (byte-stable, exactly like `label`/`formula`); `sameMeasure` ignores it. */
  description?: string;
};

/** A documented column (the documentation form). At least one with a non-empty
 *  description is required by the transparency gate before a dataset can promote. */
export type ColumnDoc = { name: string; description: string };

/** The OpenMetadata **Certification** trust badge on a Data Product. NOTE: its
 *  Bronze/Silver/Gold levels are a *trust* axis — deliberately DIFFERENT from the
 *  medallion *refinement* layer (data-architecture-model.md §Naming caution). */
export type TrustLevel = 'bronze' | 'silver' | 'gold';
export type Certification = { level: TrustLevel; by: string; at: string };
export const TRUST_LEVELS: TrustLevel[] = ['bronze', 'silver', 'gold'];

/** An ADDITIONAL dataset joined into this dataset's Gold version (stage-4 reuse). The
 *  base's own bronze→silver→gold chain is its refinement lineage; each `upstream` is a
 *  second/third source the Gold join reads — the multi-upstream edges the lineage
 *  graph renders. `fqn` is the physical table the join read; `datasetId` links back to
 *  the registry entry (a governed asset/product the builder could see). */
export type DatasetUpstream = { datasetId: string; name: string; fqn: string; joinType: 'inner' | 'left' };

/**
 * The RAW, editable Gold build spec (stage-4) — persisted so the Gold panel RE-HYDRATES
 * after a build: the join partners (datasetId + keys/type), the kept dimensions and the
 * source measures all survive, so the definition stays visible + editable + rebuildable
 * (not a one-shot black box). This is the panel's own vocabulary (datasetId-keyed joins,
 * `ref::column` dimension/measure refs), kept deliberately opaque to the SHAPE layer:
 * it is stored and returned verbatim, never interpreted here. Compilation still happens
 * server-side from the resolved FQNs (`goldJoinPlan`) — this is purely the reproducible
 * INPUT, never a trusted SQL source. ABSENT on every dataset built before this field
 * existed (and on single-table/pass-through Gold with no stored spec) — byte-stable. */
export type GoldSpecJoin = {
  datasetId: string;
  type: 'inner' | 'left';
  baseCol: string;
  joinCol: string;
  adaptMode?: 'none' | 'cast' | 'text';
  adaptType?: string;
};
export type GoldSpecDimension = { source: string; as?: string };
export type GoldSpecMeasure = { name: string; agg: string; col?: string; op?: string; col2?: string };
/** A row-level DERIVED output column in the panel's own `ref::column` vocabulary: a
 *  new column `name` = `left` `op` (`right` column | `rightValue` constant). Exactly ONE
 *  of `right`/`rightValue` is set. Stored verbatim, never trusted — the server recompiles
 *  from the resolved refs. ABSENT on every dataset built before derived fields existed
 *  (byte-stable). */
export type GoldSpecDerived = { name: string; left: string; op: string; right?: string; rightValue?: number };
export type GoldSpec = {
  joins: GoldSpecJoin[];
  dimensions: GoldSpecDimension[];
  derived?: GoldSpecDerived[];
  measures: GoldSpecMeasure[];
  /** The EXPLICIT base dataset a CURATED compose builds from (its physical gold/silver
   *  becomes the compile `source`, ref 0). ABSENT on every ingested dataset and on every
   *  dataset built before curated compose existed — absent means "own-silver base", which
   *  is byte-stable for every existing record. Stored verbatim, never trusted: the route
   *  re-resolves it through `getDataset` (entitlement + active domain) before compiling. */
  baseDatasetId?: string;
};

/** The dropdown-driven data-quality rule kinds the DQ editor offers. Each compiles
 *  to a COUNT-of-violations SQL check run through the governed query path (see
 *  `lib/data/dq.ts`). `range` uses `min`/`max`; `accepted_values` uses `values`. */
export type DataCheckRule =
  | 'not_null'
  | 'not_blank'
  | 'unique'
  | 'accepted_values'
  | 'range';

export const DATA_CHECK_RULES: DataCheckRule[] = ['not_null', 'not_blank', 'unique', 'accepted_values', 'range'];

/** A data-quality check on the dataset. A STRUCTURED rule (`rule` + `column` + args)
 *  is EXECUTABLE — compiled to a governed COUNT-of-violations SQL and run AS the owner
 *  to produce a real pass/fail. A check with no `rule` is a legacy free-text intention
 *  (kept for back-compat) and is reported as "not run". */
export type DataCheck = {
  id: string;
  name: string;
  description: string;
  createdBy: string;
  createdAt: string;
  /** The executable rule kind (absent ⇒ a legacy free-text intention). */
  rule?: DataCheckRule;
  /** The column the rule applies to (required for every executable rule). */
  column?: string;
  /** `accepted_values`: the allowed value set. */
  values?: string[];
  /** `range`: inclusive numeric bounds (either may be omitted for a one-sided range). */
  min?: number;
  max?: number;
};

/** Sync mode / cursor-kind literals — kept in LOCKSTEP with `sync-sql.ts` (this base
 *  module stays import-light so client bundles never drag the warehouse registry in).
 *  Executable kinds: timestamp | number | kafka-offsets (per-partition offsets map,
 *  append-only). The reserved kinds ('delta-version'|'bq-partition') parse but are
 *  not executable yet. */
export type DatasetSyncMode = 'full-refresh' | 'append' | 'merge';
export const DATASET_SYNC_MODES: DatasetSyncMode[] = ['full-refresh', 'append', 'merge'];
export type DatasetSyncCursorKind = 'timestamp' | 'number' | 'delta-version' | 'bq-partition' | 'kafka-offsets';
const SYNC_CURSOR_KINDS: DatasetSyncCursorKind[] = ['timestamp', 'number', 'delta-version', 'bq-partition', 'kafka-offsets'];

/** SCHEDULED INCREMENTAL SYNC config for a warehouse-imported dataset. ABSENT on every
 *  dataset without a sync (byte-stable — exactly like `monitors?`). The WATERMARK is
 *  deliberately NOT stored here: it lives in the durable sync-runs time-series
 *  (`sync-runs.ts`, cursorAfter of the latest ok run) so a config edit never clobbers
 *  sync progress and the dataset.yaml stays a pure definition. */
export type DatasetSync = {
  /** The warehouse connection the source table federates through. */
  connectionId: string;
  /** The source table inside that connection's external catalog. */
  source: { schema: string; table: string };
  mode: DatasetSyncMode;
  /** Required for append/merge (the incremental window column). */
  cursor?: { kind: DatasetSyncCursorKind; column: string };
  /** Required for merge (the natural-key match columns). */
  mergeKeys?: string[];
  /** Late-data lookback for timestamp cursors (minutes; absent ⇒ the executor's
   *  default of 15). Number cursors always sync with no lookback. */
  lookbackMinutes?: number;
  schedule: { cron: string };
  enabled: boolean;
};

/** Sharing/refinement TIER a connected (adopted) dataset carries — the curated
 *  silver/gold an exposure declares. Kept in lockstep with `ExposureTier` (this base
 *  module stays import-light so client bundles never drag the connections registry in). */
export type ConnectedTier = 'silver' | 'gold';
/** How an adopted dataset reads its source: `live` federates every read straight through
 *  to the external FQN (Phase 2); `sync` lands a governed copy (Phase 3). */
export type ConnectedMode = 'live' | 'sync';
/** The honesty state of a connected dataset's bond to its source exposure. `ok` reads
 *  normally; `drifted` = the catalog snapshot removed/changed the bound table (warn, still
 *  readable); `source-revoked` = the exposure was revoked (no data shown, reads disabled). */
export type ConnectedStatus = 'ok' | 'drifted' | 'source-revoked';

/** ADOPTED-FROM-A-CONNECTION provenance (lakehouse-import-exposure.md, Phase 2). Present
 *  ONLY when `origin:'connected'`: the dataset IS an exposed external table, not an
 *  ingested/curated one. `source` is the verbatim external `catalog.schema.table` the
 *  live FQN seam resolves to (`store-fqn.ts versionTarget`, `store.ts builtLayerFqn`);
 *  `exposureId` binds it to the ExposureSet so revocation/drift can find it. ABSENT on
 *  every non-connected dataset (byte-stable, zero migration — the `sync`/`origin` precedent). */
export type ConnectedSource = {
  connectionId: string;
  exposureId: string;
  source: { catalog: string; schema: string; table: string };
  mode: ConnectedMode;
  tier: ConnectedTier;
  status: ConnectedStatus;
};

export type Dataset = {
  version: string;
  id: string;
  name: string;
  /** The FROZEN physical slug — the stable identity every physical derivation
   *  (Iceberg FQN, Cube name/view, dbt model path) is built from. Set ONCE and
   *  NEVER changed: on create it is left ABSENT (so it defaults to `slug(name)`,
   *  keeping every existing record byte-identical), and it is WRITTEN only when a
   *  RENAME decouples the display name from the physical table — pinning the table
   *  to its slug at the moment of rename so the physical identity never moves. Read
   *  it through `physicalSlug(d)` (store-fqn.ts), never recompute from `name`.
   *  OMITTED from the yaml whenever it still equals `slug(name)` (byte-stable). */
  slug?: string;
  owner: string;
  domain: string;
  tier: Tier;
  visibility: DataVisibility;
  /** The folder this dataset lives in — a normalised path (leading slash; `'/'` is
   *  the root). Mirrors Files: additive + defaulted, so old datasets parse unchanged
   *  at the root and it is OMITTED from the yaml when at root (byte-stable). The
   *  folder ROOT (personal vs domain tree) is decided by tier, exactly like Files. */
  folder: string;
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
  /** Additional datasets joined into the Gold version (multi-upstream lineage). */
  upstreams?: DatasetUpstream[];
  /** The RAW editable Gold build spec (joins + kept columns + measures) — re-hydrates
   *  the Gold panel so the definition stays visible/editable/rebuildable. ABSENT until a
   *  Gold JOIN/single-table build stores one (byte-stable for every prior record). */
  goldSpec?: GoldSpec;
  /** Manually-authored data-quality check intentions (not auto-executed). */
  checks?: DataCheck[];
  /** Heuristic monitor toggles (freshness/volume/schema). ABSENT ⇒ all ON (default-ON);
   *  a member is stored ONLY when the owner turns it off, so a dataset that never touched
   *  the toggles serializes exactly as before (byte-stable, zero migration). */
  monitors?: { freshness?: boolean; volume?: boolean; schema?: boolean };
  /** Scheduled incremental sync config. ABSENT on every dataset without a sync
   *  (byte-stable, zero migration — the `monitors?` pattern). */
  sync?: DatasetSync;
  /** Cube identity scheme marker (#155). When true, this dataset's cube name / view /
   *  model file are DOMAIN-NAMESPACED (`<domain>__<slug>`), so two domains can each name
   *  a dataset "Sales" without colliding on one shared cube/view/model file. ABSENT ⇒
   *  legacy un-namespaced identity (`slug(name)`) — every dataset created before #155 (and
   *  the LIVE Cube models, dashboards, metric members and Power BI queries that reference
   *  them) keeps its exact old identity, so there is ZERO migration. Set once at create,
   *  immutable for the life of the dataset (so every derived name stays stable). Omitted
   *  from the yaml when false (byte-stable — old records don't churn). */
  cubeNamespaced?: boolean;
  /** Analytics-as-code gate (#146 Phase 6). When true, a promoted dataset also emits a
   *  git-backed dbt model (`dbt/models/governed/<domain>/<layer>_<slug>.sql`) + column
   *  docs (`schema.yml`) into the analytics repo. ABSENT/false ⇒ no dbt model is emitted —
   *  pre-existing datasets stay un-emitted until they are re-promoted (zero migration,
   *  byte-stable). Set at promote time. Omitted from yaml when false. */
  gitBacked?: boolean;
  /** How the dataset was born (create paths). `'curated'` = built from EXISTING governed
   *  datasets via the Gold join (the reuse path); `'connected'` = ADOPTED from a warehouse
   *  connection's exposure (lakehouse-import-exposure.md — the dataset IS an external table,
   *  see `connected`); `'ingest'`/ABSENT = the classic bring-a-file/extract path. Only
   *  `'curated'`/`'connected'` are ever written to the yaml — absent means ingest, so every
   *  pre-existing record serializes exactly as before (byte-stable, zero migration; the
   *  `cubeNamespaced` precedent). Purely descriptive: no gate reads it. */
  origin?: 'ingest' | 'curated' | 'connected';
  /** ADOPTED-FROM-A-CONNECTION block — present ONLY with `origin:'connected'`. Binds this
   *  dataset to the ExposureSet + external source it federates (live) or copies (sync).
   *  ABSENT on every non-connected dataset (byte-stable; the `sync`/`goldSpec` precedent). */
  connected?: ConnectedSource;
  /** DOCS PROVENANCE marker: `'ai-auto'` when the dataset's documentation (description +
   *  column notes) was DRAFTED automatically after ingestion (background LLM, grounded in
   *  the real schema/profile) and NOT yet touched by a human. The Documentation section
   *  shows a subtle "AI-drafted — review in Edit → Documentation" note while this is set.
   *  CLEARED the moment a human saves the Documentation section (`setDocs` from the docs
   *  route), so a reviewed/edited doc drops the marker. ABSENT ⇒ human-authored or empty
   *  docs (every dataset before this field existed) — omitted from the yaml (byte-stable,
   *  zero migration; the `origin`/`gitBacked` precedent). */
  docsProvenance?: 'ai-auto';
  /** STALE-DOMAIN-TABLE marker (Northpeak fix). Set true when a PROMOTED dataset's
   *  personal-lane Gold is REBUILT but the governed domain table (`iceberg.<domain>.gold_<slug>`
   *  — the FQN Cube + every consumer reads) was not re-materialized in the same act, so the
   *  domain copy holds a PRIOR snapshot. While true, consumers must be warned and the table
   *  re-promoted (re-run the publish CTAS). CLEARED the moment the domain CTAS re-runs. ABSENT/
   *  false ⇒ the domain table is in sync (or the dataset was never promoted) — omitted from
   *  the yaml (byte-stable, zero migration; the `gitBacked` precedent). */
  domainTableStale?: boolean;
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

export type Storage = 'personal-iceberg' | 'trino-iceberg';

/**
 * THE HARD STORAGE LINE (data-architecture-model.md): private datasets live in the
 * per-user PERSONAL Iceberg schema (`iceberg.personal_<uid>.*`), read AS the owner
 * through governed Trino; only promoted assets and certified products live in the
 * shared domain Trino/Iceberg schema. SINGLE-ENGINE: both are Trino/Iceberg — the tier
 * decides the schema + owning principal, not the engine. This is the one place that
 * line is drawn.
 */
export function storageFor(tier: Tier): Storage {
  return tier === 'dataset' ? 'personal-iceberg' : 'trino-iceberg';
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
  if (needsBuilder && !roleAtLeast(role, 'builder')) {
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
  const m: Measure = {
    name: raw.name,
    type: typeof raw.type === 'string' ? raw.type : 'count',
    sql: typeof raw.sql === 'string' ? raw.sql : '',
  };
  // Cube's richer measure model — accept both camelCase (our TS) and snake_case (Cube YAML).
  const filtersRaw = (raw.filters ?? (raw as Record<string, unknown>).filters) as unknown;
  if (Array.isArray(filtersRaw)) {
    const filters = filtersRaw
      .map((f) => (isRecord(f) && typeof f.sql === 'string' ? { sql: f.sql } : null))
      .filter((f): f is MeasureFilter => f !== null);
    if (filters.length > 0) m.filters = filters;
  }
  const rw = (raw.rollingWindow ?? (raw as Record<string, unknown>).rolling_window) as unknown;
  if (isRecord(rw)) {
    const win: RollingWindow = {};
    if (typeof rw.trailing === 'string') win.trailing = rw.trailing;
    if (typeof rw.leading === 'string') win.leading = rw.leading;
    if (rw.offset === 'start' || rw.offset === 'end') win.offset = rw.offset;
    if (win.trailing || win.leading || win.offset) m.rollingWindow = win;
  }
  if (typeof raw.format === 'string' && raw.format) m.format = raw.format;
  // The DISPLAY label a rename writes (freezing `name`); round-trips so a renamed metric
  // keeps its display name across persist/hydrate.
  if (typeof raw.label === 'string' && raw.label) m.label = raw.label;
  // The plain-language "what does this metric mean?" sentence. Absent on every measure
  // created before this field existed (byte-stable, like `label`).
  if (typeof raw.description === 'string' && raw.description) m.description = raw.description;
  // COMPOSITE metric source formula — without this parse the human-readable formula was
  // LOST on store reload (sql survived; Edit hydration fell back to nothing). Latent gap
  // found during the description work; round-trips byte-stably like label/description.
  if (typeof raw.formula === 'string' && raw.formula) m.formula = raw.formula;
  const dm = (raw.drillMembers ?? (raw as Record<string, unknown>).drill_members) as unknown;
  if (Array.isArray(dm)) {
    const members = dm.map((x) => String(x)).filter(Boolean);
    if (members.length > 0) m.drillMembers = members;
  }
  return m;
}

function parseColumn(raw: unknown, i: number): ColumnDoc {
  if (!isRecord(raw) || typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new DatasetError(`dataset.yaml: columns[${i}] needs a string 'name'`);
  }
  return { name: raw.name, description: typeof raw.description === 'string' ? raw.description : '' };
}

function parseUpstream(raw: unknown, i: number): DatasetUpstream {
  if (!isRecord(raw) || typeof raw.fqn !== 'string' || raw.fqn.length === 0) {
    throw new DatasetError(`dataset.yaml: upstreams[${i}] needs a string 'fqn'`);
  }
  return {
    datasetId: typeof raw.datasetId === 'string' ? raw.datasetId : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    fqn: raw.fqn,
    joinType: raw.joinType === 'left' ? 'left' : 'inner',
  };
}

/** Re-hydrate the raw Gold spec, tolerating any absent/loose field (it is stored
 *  verbatim, never trusted — the server re-compiles from resolved FQNs). Missing arrays
 *  collapse to empty so a partial record still opens. */
export function parseGoldSpec(raw: unknown): GoldSpec | undefined {
  if (!isRecord(raw)) return undefined;
  const joins = (Array.isArray(raw.joins) ? raw.joins : [])
    .filter(isRecord)
    .map((j): GoldSpecJoin => ({
      datasetId: typeof j.datasetId === 'string' ? j.datasetId : '',
      type: j.type === 'left' ? 'left' : 'inner',
      baseCol: typeof j.baseCol === 'string' ? j.baseCol : '',
      joinCol: typeof j.joinCol === 'string' ? j.joinCol : '',
      ...(j.adaptMode === 'cast' || j.adaptMode === 'text' || j.adaptMode === 'none' ? { adaptMode: j.adaptMode } : {}),
      ...(typeof j.adaptType === 'string' ? { adaptType: j.adaptType } : {}),
    }));
  const dimensions = (Array.isArray(raw.dimensions) ? raw.dimensions : [])
    .filter(isRecord)
    .map((d): GoldSpecDimension => ({
      source: typeof d.source === 'string' ? d.source : '',
      ...(typeof d.as === 'string' && d.as ? { as: d.as } : {}),
    }));
  const measures = (Array.isArray(raw.measures) ? raw.measures : [])
    .filter(isRecord)
    .map((m): GoldSpecMeasure => ({
      name: typeof m.name === 'string' ? m.name : '',
      agg: typeof m.agg === 'string' ? m.agg : 'sum',
      ...(typeof m.col === 'string' && m.col ? { col: m.col } : {}),
      ...(typeof m.op === 'string' && m.op ? { op: m.op } : {}),
      ...(typeof m.col2 === 'string' && m.col2 ? { col2: m.col2 } : {}),
    }));
  // Derived fields: absent stays absent (byte-stable for every pre-derived record). A
  // row keeps a `right` column OR a finite `rightValue` constant — never both; when
  // both appear the column ref wins (deterministic re-hydration).
  const derived = (Array.isArray(raw.derived) ? raw.derived : [])
    .filter(isRecord)
    .map((d): GoldSpecDerived => ({
      name: typeof d.name === 'string' ? d.name : '',
      left: typeof d.left === 'string' ? d.left : '',
      op: typeof d.op === 'string' ? d.op : '',
      ...(typeof d.right === 'string' && d.right
        ? { right: d.right }
        : typeof d.rightValue === 'number' && Number.isFinite(d.rightValue)
          ? { rightValue: d.rightValue }
          : {}),
    }));
  // The explicit curated base (nil-safe): absent stays absent — byte-stable for every
  // ingested dataset and every pre-curated record (absent ⇒ own-silver base).
  const baseDatasetId = typeof raw.baseDatasetId === 'string' && raw.baseDatasetId ? raw.baseDatasetId : undefined;
  if (joins.length === 0 && dimensions.length === 0 && derived.length === 0 && measures.length === 0 && !baseDatasetId) return undefined;
  return { joins, dimensions, ...(derived.length > 0 ? { derived } : {}), measures, ...(baseDatasetId ? { baseDatasetId } : {}) };
}

/** Re-hydrate the sync block. Tolerant like `parseGoldSpec`: a record missing its
 *  essentials (connection, source table, valid mode, valid cron) parses to undefined
 *  rather than bricking the dataset — the setter is the strict gate. */
export function parseSyncBlock(raw: unknown): DatasetSync | undefined {
  if (!isRecord(raw)) return undefined;
  const src = isRecord(raw.source) ? raw.source : {};
  const sched = isRecord(raw.schedule) ? raw.schedule : {};
  const mode = raw.mode as DatasetSyncMode;
  if (
    typeof raw.connectionId !== 'string' || !raw.connectionId ||
    typeof src.schema !== 'string' || !src.schema ||
    typeof src.table !== 'string' || !src.table ||
    !DATASET_SYNC_MODES.includes(mode) ||
    !isValidCron(typeof sched.cron === 'string' ? sched.cron : undefined)
  ) {
    return undefined;
  }
  const out: DatasetSync = {
    connectionId: raw.connectionId,
    source: { schema: src.schema, table: src.table },
    mode,
    schedule: { cron: String(sched.cron) },
    enabled: raw.enabled === true,
  };
  const cur = raw.cursor;
  if (isRecord(cur) && typeof cur.column === 'string' && cur.column &&
      (SYNC_CURSOR_KINDS as string[]).includes(String(cur.kind))) {
    out.cursor = { kind: cur.kind as DatasetSyncCursorKind, column: cur.column };
  }
  if (Array.isArray(raw.mergeKeys)) {
    const keys = raw.mergeKeys.map((k) => String(k)).filter(Boolean);
    if (keys.length > 0) out.mergeKeys = keys;
  }
  if (typeof raw.lookbackMinutes === 'number' && Number.isInteger(raw.lookbackMinutes) && raw.lookbackMinutes >= 0) {
    out.lookbackMinutes = raw.lookbackMinutes;
  }
  return out;
}

/** Re-hydrate the `connected` block. Tolerant like `parseSyncBlock`: a record missing its
 *  essentials (connection, exposure, a full catalog.schema.table) parses to undefined
 *  rather than bricking the dataset. `mode`/`tier`/`status` fall back to safe defaults so
 *  an older/partial record still opens (live · silver · ok). */
export function parseConnectedBlock(raw: unknown): ConnectedSource | undefined {
  if (!isRecord(raw)) return undefined;
  const src = isRecord(raw.source) ? raw.source : {};
  const connectionId = typeof raw.connectionId === 'string' ? raw.connectionId : '';
  const exposureId = typeof raw.exposureId === 'string' ? raw.exposureId : '';
  const catalog = typeof src.catalog === 'string' ? src.catalog : '';
  const schema = typeof src.schema === 'string' ? src.schema : '';
  const table = typeof src.table === 'string' ? src.table : '';
  if (!connectionId || !exposureId || !catalog || !schema || !table) return undefined;
  const mode: ConnectedMode = raw.mode === 'sync' ? 'sync' : 'live';
  const tier: ConnectedTier = raw.tier === 'gold' ? 'gold' : 'silver';
  const status: ConnectedStatus =
    raw.status === 'drifted' ? 'drifted' : raw.status === 'source-revoked' ? 'source-revoked' : 'ok';
  return { connectionId, exposureId, source: { catalog, schema, table }, mode, tier, status };
}

function parseCheck(raw: unknown, i: number): DataCheck {
  if (!isRecord(raw)) throw new DatasetError(`dataset.yaml: checks[${i}] must be a mapping`);
  const base: DataCheck = {
    id: typeof raw.id === 'string' ? raw.id : `chk_${i}`,
    name: typeof raw.name === 'string' ? raw.name : 'Untitled check',
    description: typeof raw.description === 'string' ? raw.description : '',
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
  };
  const rule = raw.rule;
  if (typeof rule === 'string' && (DATA_CHECK_RULES as string[]).includes(rule)) {
    base.rule = rule as DataCheckRule;
    if (typeof raw.column === 'string') base.column = raw.column;
    if (Array.isArray(raw.values)) base.values = raw.values.map((x) => String(x));
    if (typeof raw.min === 'number') base.min = raw.min;
    if (typeof raw.max === 'number') base.max = raw.max;
  }
  return base;
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
  const checksRaw = Array.isArray(doc.checks) ? doc.checks : [];

  let certification: Certification | undefined;
  if (isRecord(doc.certification) && TRUST_LEVELS.includes(doc.certification.level as TrustLevel)) {
    const c = doc.certification;
    certification = { level: c.level as TrustLevel, by: String(c.by ?? ''), at: String(c.at ?? '') };
  }
  const imports = Array.isArray(doc.imports) ? doc.imports.map((x) => String(x)) : undefined;
  const upstreams = Array.isArray(doc.upstreams) ? doc.upstreams.map(parseUpstream) : undefined;
  const goldSpec = parseGoldSpec(doc.goldSpec);
  const checks = checksRaw.length > 0 ? checksRaw.map(parseCheck) : undefined;
  // Monitor toggles: only an explicit `false` is stored (default-ON). Any member absent
  // ⇒ that monitor is on. An empty/all-true object collapses to undefined (byte-stable).
  let monitors: Dataset['monitors'];
  if (isRecord(doc.monitors)) {
    const m: NonNullable<Dataset['monitors']> = {};
    for (const k of ['freshness', 'volume', 'schema'] as const) {
      if (doc.monitors[k] === false) m[k] = false;
    }
    if (Object.keys(m).length > 0) monitors = m;
  }
  const sync = parseSyncBlock(doc.sync);
  // The FROZEN physical slug: only stored once a rename has DECOUPLED it from the
  // name. Absent ⇒ still derivable from the name (`physicalSlug` falls back to
  // `slug(name)`), so every pre-rename record parses with no slug — byte-stable.
  const slugRaw = typeof doc.slug === 'string' && doc.slug.trim() ? doc.slug.trim() : undefined;
  // #155: absent/false ⇒ legacy un-namespaced cube identity (every pre-#155 record).
  const cubeNamespaced = doc.cubeNamespaced === true ? true : undefined;
  // #146 Phase 6: absent/false ⇒ no dbt model emitted (pre-existing datasets stay un-emitted).
  const gitBacked = doc.gitBacked === true ? true : undefined;
  // Northpeak fix: absent/false ⇒ the domain table is in sync (or never promoted).
  const domainTableStale = doc.domainTableStale === true ? true : undefined;
  // Create paths: only 'curated'/'connected' are stored; absent ⇒ ingest (every pre-existing
  // record). A 'connected' record must carry a valid `connected` block; a malformed block
  // downgrades the origin to ingest so nothing half-connected leaks into the FQN seam.
  const connected = parseConnectedBlock(doc.connected);
  const origin =
    doc.origin === 'connected' && connected
      ? ('connected' as const)
      : doc.origin === 'curated'
        ? ('curated' as const)
        : undefined;
  // Auto-docs: only 'ai-auto' is stored; absent ⇒ human-authored/empty (every pre-existing record).
  const docsProvenance = doc.docsProvenance === 'ai-auto' ? ('ai-auto' as const) : undefined;

  return {
    version: doc.version !== undefined ? String(doc.version) : '1',
    id: typeof doc.id === 'string' ? doc.id : '',
    name: typeof doc.name === 'string' ? doc.name : 'Untitled dataset',
    ...(slugRaw ? { slug: slugRaw } : {}),
    owner: typeof doc.owner === 'string' ? doc.owner : '',
    domain: typeof doc.domain === 'string' ? doc.domain : '',
    tier,
    // A dataset is always private; tier+visibility are kept consistent on parse.
    visibility: visibilityFor(tier, visRaw),
    // Additive + defaulted: absent → root. Normalised so equality/prefix checks are stable.
    folder: normaliseFolderPath(typeof doc.folder === 'string' ? doc.folder : undefined),
    description: typeof doc.description === 'string' ? doc.description : '',
    versions: parseVersions(doc.versions),
    grants: grantsRaw.map(parseGrant),
    measures: measuresRaw.map(parseMeasure),
    columns: columnsRaw.map(parseColumn),
    ...(certification ? { certification } : {}),
    ...(imports ? { imports } : {}),
    ...(upstreams ? { upstreams } : {}),
    ...(goldSpec ? { goldSpec } : {}),
    ...(checks ? { checks } : {}),
    ...(monitors ? { monitors } : {}),
    ...(sync ? { sync } : {}),
    ...(cubeNamespaced ? { cubeNamespaced } : {}),
    ...(gitBacked ? { gitBacked } : {}),
    ...(domainTableStale ? { domainTableStale } : {}),
    ...(origin ? { origin } : {}),
    // Only carry `connected` when the origin is genuinely connected (a stray block on a
    // non-connected record is dropped — byte-stable, and the FQN seam only trusts origin).
    ...(origin === 'connected' && connected ? { connected } : {}),
    ...(docsProvenance ? { docsProvenance } : {}),
  };
}

/** The lowercase, guard-safe physical slug of a display name. Kept in lockstep with
 *  `slug` in store-fqn.ts / metrics.ts (this base module must stay import-free of them
 *  to avoid a cycle). Used ONLY to decide when the frozen `slug` is still derivable and
 *  can be omitted from the yaml (byte-stability). */
function nameSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'dataset';
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
  // The FROZEN physical slug is written ONLY once a rename has decoupled it from the
  // name (i.e. it no longer equals `slug(name)`). While still derivable it is OMITTED,
  // so every dataset that has never been renamed serializes byte-identically to before.
  if (d.slug && d.slug !== nameSlug(d.name)) doc.slug = d.slug;
  // Omit-when-root (byte-stable, like the `layer !== 'gold'` omit precedent): a
  // dataset at the root serializes exactly as before, so no old record churns.
  if (d.folder && normaliseFolderPath(d.folder) !== '/') doc.folder = normaliseFolderPath(d.folder);
  if (d.description) doc.description = d.description;
  doc.versions = d.versions;
  if (d.grants.length > 0) doc.grants = d.grants;
  if (d.measures.length > 0) doc.measures = d.measures;
  if (d.columns.length > 0) doc.columns = d.columns;
  if (d.certification) doc.certification = d.certification;
  if (d.imports && d.imports.length > 0) doc.imports = d.imports;
  if (d.upstreams && d.upstreams.length > 0) doc.upstreams = d.upstreams;
  // Omit-when-empty (byte-stable): a Gold spec is written only once a Gold build stores
  // one; every dataset without a stored spec serializes exactly as before.
  if (d.goldSpec && (d.goldSpec.joins.length > 0 || d.goldSpec.dimensions.length > 0 || (d.goldSpec.derived?.length ?? 0) > 0 || d.goldSpec.measures.length > 0 || !!d.goldSpec.baseDatasetId)) {
    // Omit an EMPTY `derived` array so a spec with no derived fields serializes exactly
    // as it did before derived fields existed (byte-stable — no prior record churns).
    // Likewise drop a falsy `baseDatasetId` so an ingested spec never emits an empty-string
    // key (byte-stable — a curated base only writes when actually set).
    const { derived, baseDatasetId, ...rest } = d.goldSpec;
    const withDerived = derived && derived.length > 0 ? { ...rest, derived } : rest;
    doc.goldSpec = baseDatasetId ? { ...withDerived, baseDatasetId } : withDerived;
  }
  if (d.checks && d.checks.length > 0) doc.checks = d.checks;
  // Only persist explicitly-disabled monitors (default-ON); an all-on dataset omits the
  // key entirely, so nothing that never touched the toggles churns in the mirror.
  if (d.monitors) {
    const m: Record<string, boolean> = {};
    for (const k of ['freshness', 'volume', 'schema'] as const) {
      if (d.monitors[k] === false) m[k] = false;
    }
    if (Object.keys(m).length > 0) doc.monitors = m;
  }
  // Omit-when-absent (byte-stable): only a dataset with a configured sync writes the
  // block; optional members are omitted so the yaml stays minimal + stable.
  if (d.sync) {
    doc.sync = {
      connectionId: d.sync.connectionId,
      source: { schema: d.sync.source.schema, table: d.sync.source.table },
      mode: d.sync.mode,
      ...(d.sync.cursor ? { cursor: { kind: d.sync.cursor.kind, column: d.sync.cursor.column } } : {}),
      ...(d.sync.mergeKeys && d.sync.mergeKeys.length > 0 ? { mergeKeys: d.sync.mergeKeys } : {}),
      ...(d.sync.lookbackMinutes !== undefined ? { lookbackMinutes: d.sync.lookbackMinutes } : {}),
      schedule: { cron: d.sync.schedule.cron },
      enabled: d.sync.enabled,
    };
  }
  // Omit-when-false (byte-stable): a legacy (un-namespaced) dataset serializes exactly
  // as before #155, so no old record churns in the durable mirror.
  if (d.cubeNamespaced) doc.cubeNamespaced = true;
  // Omit-when-false (#146 Phase 6): pre-existing datasets serialize exactly as before,
  // un-emitted until re-promoted with gitBacked=true.
  if (d.gitBacked) doc.gitBacked = true;
  // Omit-when-false (byte-stable): only a promoted dataset whose domain table drifted
  // from a rebuild carries this; every in-sync/un-promoted dataset serializes as before.
  if (d.domainTableStale) doc.domainTableStale = true;
  // Omit-unless-curated/connected (byte-stable): the classic ingest path serializes exactly
  // as before. A connected dataset writes its origin + the `connected` block together (the
  // block is meaningless without the origin, and vice versa).
  if (d.origin === 'curated') doc.origin = 'curated';
  else if (d.origin === 'connected' && d.connected) {
    doc.origin = 'connected';
    doc.connected = {
      connectionId: d.connected.connectionId,
      exposureId: d.connected.exposureId,
      source: { catalog: d.connected.source.catalog, schema: d.connected.source.schema, table: d.connected.source.table },
      mode: d.connected.mode,
      tier: d.connected.tier,
      status: d.connected.status,
    };
  }
  // Omit-unless-ai-auto (byte-stable): human-authored/empty docs serialize exactly as before.
  if (d.docsProvenance === 'ai-auto') doc.docsProvenance = 'ai-auto';
  return yaml.dump(doc, { lineWidth: 100, noRefs: true });
}

/** A fresh empty version (nothing built yet). */
export function emptyVersion(): VersionState {
  return { built: false, passThrough: false, quality: 'unknown', updatedAt: null, artifact: null };
}

export function emptyVersions(): Versions {
  return { bronze: emptyVersion(), silver: emptyVersion(), gold: emptyVersion() };
}
