/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type Role, roleAtLeast } from '../core/session.ts';
import {
  type Dataset,
  type DataVisibility,
  type Grant,
  type Layer,
  type Measure,
  type Quality,
  type Tier,
  type Transition,
  type VersionState,
  type ColumnDoc,
  type TrustLevel,
  type DatasetUpstream,
  type DataCheck,
  DatasetError,
  canTransition,
  emptyVersions,
  parseDataset,
  serializeDataset,
  storageFor,
  tierAfter,
  visibilityFor,
} from './dataset-schema.ts';
import { transparencyGate, gateReason } from './transparency.ts';
import { CUBE_ARTIFACT, EXPOSURE_ARTIFACT, scaffoldCubeYaml, scaffoldExposureYaml, metricGoldReady } from './metrics.ts';
import { assetTarget, productTarget, personalSchema, domainSchema, slug, versionTarget } from './store-fqn.ts';
import { config } from '../core/config.ts';
import { osMirror } from '../infra/os-mirror.ts';
import { type ArtifactVersion, versionLog } from '../core/versioning.ts';

// Re-export the FQN helpers so existing consumers keep importing them from the store.
export { assetTarget, productTarget } from './store-fqn.ts';

/**
 * The dataset registry — the MOCK store behind the Data tab (kind-only, in-process;
 * no Supabase yet). It maps 1:1 to the future Supabase `datasets` table: each record
 * persists exactly ONE canonical source file, `dataset.yaml`; the tool-native files
 * (dlt / dbt / cube) are PROJECTIONS addressed by each version's `artifact` path, so
 * the guided panels, the Monaco "Show the code" view and the data agent all edit the
 * same single source (mirrors lib/agents/store.ts, Approach A).
 *
 * Kept free of `server-only` / Next imports so it is unit-testable directly; the API
 * routes are the server boundary that authenticates + scopes callers.
 */

export type Principal = { id: string; domains: string[]; role: Role };

export type DatasetRecord = {
  id: string;
  owner: string;
  domain: string;
  /** The single source of truth. */
  yaml: string;
  /** Tool-native artifact bodies (dbt SQL + tests), keyed by version artifact path.
   *  The dataset.yaml spine points at these; both are Forgejo-versioned (dual-mode). */
  artifacts?: Record<string, string>;
  updatedAt: string;
  /** Soft-archived: hidden from the working lists, reversible, retained. */
  archived?: boolean;
};

export type DatasetSummary = {
  id: string;
  name: string;
  owner: string;
  domain: string;
  tier: Tier;
  visibility: DataVisibility;
  /** Furthest built medallion layer, or null if nothing built. */
  freshness: string | null;
  quality: Quality;
  /** B/S/G dots for the tile. */
  dots: { bronze: boolean; silver: boolean; gold: boolean };
  storage: ReturnType<typeof storageFor>;
  /** Soft-archived (retained, reversible). Absent/false = live. */
  archived?: boolean;
};

type DataStoreState = {
  store: Map<string, DatasetRecord>;
  seeded: boolean;
  hydration: Promise<void> | null;
  /** Set when the last hydration found the mirror DOWN — gates the throttled retry. */
  hydrateFailedAt?: number;
};
const DS_KEY = Symbol.for('soa.data.store');
function ds(): DataStoreState {
  const g = globalThis as unknown as Record<symbol, DataStoreState | undefined>;
  if (!g[DS_KEY]) g[DS_KEY] = { store: new Map(), seeded: false, hydration: null };
  return g[DS_KEY]!;
}

function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------- durable mirror (best-effort) --
/**
 * Durability mirrors the artifact/app/user stores: this in-process Map is the
 * authoritative fast cache (works with NO cluster), plus a best-effort OpenSearch
 * mirror ("os-datasets") so the seeded Northpeak datasets/metrics SURVIVE an os-ui
 * restart (metrics/store derives read-only from here, so it becomes durable too).
 * Hydration is awaited ONCE at the app-tier seam (lib/data/server.ts); writes are
 * mirrored fire-and-forget. Every backend path is graceful — an unreachable
 * OpenSearch NEVER fails a request; the store simply stays in-memory.
 *
 * The probe/bootstrap/write-through core is the shared `lib/os-mirror.ts` (a
 * missing index is CREATED on first contact, never mistaken for a dead mirror).
 * Kept free of `server-only`/Next imports so the store stays unit-testable.
 */

const mirror = osMirror({
  index: config.datasetsIndex,
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        owner: { type: 'keyword' },
        domain: { type: 'keyword' },
        updatedAt: { type: 'date' },
        // The single-source yaml + tool-native bodies are STORED (in _source)
        // but not indexed: `artifacts` has arbitrary file-path keys, which
        // would otherwise explode the mapping.
        yaml: { type: 'text', index: false },
        artifacts: { type: 'object', enabled: false },
        archived: { type: 'boolean' },
      },
    },
  },
});

function writeThrough(rec: DatasetRecord): void {
  mirror.writeThrough(rec.id, rec);
}

/**
 * Version history for datasets. Datasets are NOT git-backed (no per-dataset Forgejo
 * repo — the medallion builds live in the store + durable mirror), so they ride the
 * SAME append-only snapshot log every non-git artifact shares (files/dashboards/…).
 * Each meaningful edit snapshots the PRIOR `dataset.yaml` before it is overwritten,
 * so "restore a previous version" reverts the dataset definition (and is itself an
 * auditable, reversible version). Its own `os-versions-dataset` mirror.
 */
const versions = versionLog('dataset');

function snapshotState(rec: DatasetRecord): { yaml: string } {
  return { yaml: rec.yaml };
}

/**
 * Hydrate the in-process cache from the durable mirror, once per process. Awaited
 * at the server boundary (requirePrincipal) BEFORE any read, so a restarted os-ui
 * serves the persisted datasets. Idempotent + graceful (offline → in-memory only).
 */
/** Retry a failed hydration at most this often (a down mirror must not add a
 *  probe round-trip to EVERY request — mirrors os-mirror's write reprobe). */
const HYDRATE_RETRY_MS = 60_000;

export async function ensureHydrated(): Promise<void> {
  const s = ds();
  if (!s.hydration) {
    // After a mirror-down hydration, retry (throttled) instead of staying pinned
    // to an empty registry for the pod's lifetime — a transient OpenSearch blip
    // at boot must not "lose" every mirrored dataset until the next deploy.
    if (s.hydrateFailedAt && Date.now() - s.hydrateFailedAt < HYDRATE_RETRY_MS) return;
    s.hydration = hydrate();
  }
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = ds();
  const docs = await mirror.hydrate(1000);
  if (docs === null) {
    // Mirror down → stay un-hydrated and retry on a later read (never cache a
    // FAILED hydration as done — the oauth store's rule).
    s.hydrateFailedAt = Date.now();
    s.hydration = null;
    return;
  }
  s.hydrateFailedAt = undefined;
  for (const rec of docs as DatasetRecord[]) {
    // Don't clobber records created in-process before hydration completed.
    if (rec && rec.id && !s.store.has(rec.id)) s.store.set(rec.id, rec);
  }
  // Hydrate the snapshot version log alongside the datasets (best-effort).
  await versions.ensureHydrated();
  s.seeded = true;
}

function newId(): string {
  return `ds_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

function sha(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) h = (Math.imul(31, h) + content.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

function fail(message: string, status: number): never {
  throw new DatasetError(message, status);
}

// ------------------------------------------------------------------- seeding --

/** A fresh tenant starts EMPTY. Content is created only through the platform's
 *  own governed flows (e.g. the Northpeak e-commerce seed), never baked in. */
function ensureSeeded(): void {
  if (ds().seeded) return;
  ds().seeded = true;
}

/** Test hook: wipe the in-process store + reseed (and forget the durable mirror
 *  state, so a fresh hydration can run — mirrors an os-ui restart). */
export function __resetStore(): void {
  const s = ds();
  s.store.clear();
  s.seeded = false;
  s.hydration = null;
  s.hydrateFailedAt = undefined;
  mirror.__reset();
  versions.__reset();
}

// ------------------------------------------------------------------- scoping --

function get(id: string): DatasetRecord {
  ensureSeeded();
  const rec = ds().store.get(id);
  if (!rec) fail('Dataset not found', 404);
  return rec;
}

/** Who can SEE a dataset: the owner always; a domain peer once it is a shared/domain
 *  asset; anyone for a discoverable product. Private datasets are owner-only — the
 *  hard isolation the personal lane depends on. */
function canView(d: Dataset, user: Principal): boolean {
  if (d.owner === user.id) return true;
  if (d.tier === 'dataset') return false; // private, owner-only
  if (d.tier === 'product') return true; // marketplace-discoverable
  // asset: domain peers (or named individuals via grants)
  if (user.domains.includes(d.domain)) return true;
  return d.grants.some((g) => (g.grantee.kind === 'user' && g.grantee.id === user.id));
}

function canEdit(d: Dataset, user: Principal): boolean {
  if (d.owner === user.id) return true;
  return user.role === 'admin' && user.domains.includes(d.domain);
}

function viewOf(rec: DatasetRecord, user: Principal): Dataset {
  const d = parseDataset(rec.yaml);
  if (!canView(d, user)) fail('Not permitted to view this dataset', 403);
  return d;
}

function editOf(rec: DatasetRecord, user: Principal): Dataset {
  const d = parseDataset(rec.yaml);
  if (!canEdit(d, user)) fail('Not permitted to edit this dataset', 403);
  return d;
}

function persist(rec: DatasetRecord, d: Dataset, snap?: { author: string; summary: string }): DatasetRecord {
  // Capture the PRIOR dataset.yaml as a version BEFORE overwriting it, so the
  // history holds every superseded definition (mirrors lib/files/store.ts). Only
  // user-facing edits pass `snap`; lifecycle/promotion flips (own governance trail)
  // don't churn the version log.
  if (snap && rec.yaml) versions.record(rec.id, snap.author, snapshotState(rec), snap.summary);
  rec.yaml = serializeDataset(d);
  rec.owner = d.owner;
  rec.domain = d.domain;
  rec.updatedAt = now();
  writeThrough(rec); // best-effort durable mirror
  return rec;
}

// --------------------------------------------------------------------- lists --

function furthest(d: Dataset): { freshness: string | null; layer: Layer | null } {
  const order: Layer[] = ['gold', 'silver', 'bronze'];
  for (const l of order) {
    const v = d.versions[l];
    if (v.built) return { freshness: v.updatedAt, layer: l };
  }
  return { freshness: null, layer: null };
}

function summarise(d: Dataset, archived = false): DatasetSummary {
  const f = furthest(d);
  const built = f.layer ? d.versions[f.layer] : null;
  return {
    id: d.id,
    name: d.name,
    owner: d.owner,
    domain: d.domain,
    tier: d.tier,
    visibility: d.visibility,
    freshness: f.freshness,
    quality: built ? built.quality : 'unknown',
    dots: { bronze: d.versions.bronze.built, silver: d.versions.silver.built, gold: d.versions.gold.built },
    storage: storageFor(d.tier),
    archived,
  };
}

export type DatasetGroups = { mine: DatasetSummary[]; domain: DatasetSummary[]; marketplace: DatasetSummary[] };

export function listDatasets(user: Principal, opts: { includeArchived?: boolean } = {}): DatasetGroups {
  ensureSeeded();
  const mine: DatasetSummary[] = [];
  const domain: DatasetSummary[] = [];
  const marketplace: DatasetSummary[] = [];
  for (const rec of ds().store.values()) {
    // Archived datasets are HIDDEN by default (soft archive) — the owner/Admin can
    // list them explicitly via `includeArchived` to restore or delete. A shared/
    // certified dataset, once archived, disappears from everyone's list too.
    if (rec.archived && !opts.includeArchived) continue;
    const d = parseDataset(rec.yaml);
    if (!canView(d, user)) continue;
    // Group by VISIBILITY (tier), not ownership: a promoted asset is domain data and
    // belongs under Domain even when the caller authored it; a certified product under
    // Marketplace; a private dataset (owner-only, via canView) under Personal.
    if (d.tier === 'product') marketplace.push(summarise(d, rec.archived));
    else if (d.tier === 'asset') domain.push(summarise(d, rec.archived));
    else mine.push(summarise(d, rec.archived));
  }
  const byName = (a: DatasetSummary, b: DatasetSummary) => a.name.localeCompare(b.name);
  return { mine: mine.sort(byName), domain: domain.sort(byName), marketplace: marketplace.sort(byName) };
}

export function getDataset(id: string, user: Principal): Dataset {
  return viewOf(get(id), user);
}

/** Prove EDIT authority on a dataset (owner or domain admin) and return it. The metric
 *  lifecycle uses this so archive/history stay edit-scoped — consistent with the other
 *  artifact tabs — even for ops (archive/history) that don't themselves write the yaml. */
export function requireDatasetEditable(id: string, user: Principal): Dataset {
  return editOf(get(id), user);
}

/**
 * The physical Trino FQN of a dataset's built medallion layer, resolved VIEWER-AWARE
 * (the SAME rule as {@link versionTarget}, so preview/profile target the exact table the
 * ask/query surface would): the OWNER reads EVERY layer from their own `personal_<uid>`
 * lane — that lane physically holds bronze plus any un-promoted silver/gold, so an
 * un-promoted layer read must NOT target the domain schema (TABLE_NOT_FOUND); a non-owner
 * reads the promoted copy from the domain schema (bronze is never shared there → it simply
 * won't resolve, fail-closed). The FQN's schema and the returned principal ALWAYS agree —
 * the read runs AS the identity that owns the schema (personal lane ⇒ owner, domain ⇒
 * domain principal). We NEVER build a `personal_<otherUser>` FQN for a non-owner. Returns
 * null when the requested layer (or, absent one, the furthest built layer) isn't built —
 * the caller then answers "not materialized yet" instead of building a doomed FQN.
 */
export function builtLayerFqn(
  d: Dataset,
  user: Principal,
  layer?: Layer,
): { layer: Layer; fqn: string; principal: string } | null {
  const chosen = layer && d.versions[layer]?.built ? layer : furthest(d).layer;
  if (!chosen) return null;
  // FAIL-CLOSED, owner-aware: only the OWNER resolves to the personal lane and is read AS
  // the owner; everyone else resolves to the domain schema and is read as the domain
  // principal. versionTarget encodes the SAME schema rule so the two never drift.
  const isOwner = user.id === d.owner;
  const fqn = versionTarget(d, chosen, { id: user.id });
  const principal = isOwner ? user.id : (user.domains[0] ?? user.id);
  return { layer: chosen, fqn, principal };
}

/**
 * All governed datasets (shared assets + certified products), UNSCOPED — the source
 * the Cube model-sync sidecar reads via `GET /api/cube/models`. Deliberately not
 * user-scoped: it emits ONLY governed tiers, so a private `dataset` (owner-only,
 * personal lane) NEVER appears — the endpoint hands out model definitions + access
 * policies, never row data, and is cluster-internal (see that route's trust-boundary
 * note). The physical "Gold is built" gate lives in `cube-models.cubeDeliverable`.
 */
export function listGovernedDatasets(): Dataset[] {
  ensureSeeded();
  const out: Dataset[] = [];
  for (const rec of ds().store.values()) {
    const d = parseDataset(rec.yaml);
    if (d.tier !== 'dataset') out.push(d);
  }
  return out;
}

/** A dataset the caller may JOIN into a Gold build (stage-4 reuse). */
export type JoinableDataset = { id: string; name: string; domain: string; tier: Tier; fqn: string; columns: string[] };

/**
 * The canView-scoped list of OTHER datasets the caller can reuse in a Gold join: only
 * governed tiers (asset/product) they may READ (never a private dataset they don't own)
 * that actually have a physical table (silver/gold built). This is the SAME `canView`
 * gate the catalog/list use — the join picker can never surface a dataset the caller
 * can't see, and the route re-checks `getDataset` per pick as defense in depth.
 */
export function listJoinable(user: Principal, excludeId?: string): JoinableDataset[] {
  ensureSeeded();
  const out: JoinableDataset[] = [];
  for (const rec of ds().store.values()) {
    const d = parseDataset(rec.yaml);
    if (d.id === excludeId) continue;
    if (d.tier === 'dataset') continue; // private, owner-only — not reusable
    if (!canView(d, user)) continue; // the hard visibility gate
    if (!d.versions.gold.built && !d.versions.silver.built) continue; // must be materialized
    out.push({ id: d.id, name: d.name, domain: d.domain, tier: d.tier, fqn: assetTarget(d), columns: d.columns.map((c) => c.name) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** One dataset the Ask (NL→SQL) surface may show the model. */
export type AskableDataset = {
  id: string;
  name: string;
  domain: string;
  tier: Tier;
  /** Physical Trino FQN of the furthest BUILT layer. */
  fqn: string;
  description: string;
  columns: ColumnDoc[];
};

/**
 * The canView-scoped datasets Talk-to-your-data may put in the LLM prompt: ONLY
 * datasets the caller may READ (the same `canView` gate the catalog/join picker
 * use — another user's private schema/docs can NEVER appear here) that have a
 * built physical layer to query. The FQN mirrors the write path: a private
 * dataset lives in the caller's OWN `personal_<uid>` schema (canView private ⇒
 * owner === caller), a governed asset/product in its domain schema.
 */
export function listAskable(user: Principal): AskableDataset[] {
  ensureSeeded();
  const out: AskableDataset[] = [];
  for (const rec of ds().store.values()) {
    const d = parseDataset(rec.yaml);
    if (!canView(d, user)) continue; // the hard visibility gate
    const f = furthest(d);
    if (!f.layer) continue; // nothing materialized — nothing to query
    const schema = d.tier === 'dataset' ? personalSchema(user.id) : domainSchema(d.domain);
    out.push({
      id: d.id,
      name: d.name,
      domain: d.domain,
      tier: d.tier,
      fqn: `iceberg.${schema}.${f.layer}_${slug(d.name)}`,
      description: d.description,
      columns: d.columns,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------------------------------------- create / edit --

export function createDataset(user: Principal, input: { name: string; domain?: string }): Dataset {
  ensureSeeded();
  const domain = input.domain && user.domains.includes(input.domain) ? input.domain : user.domains[0] ?? 'platform';
  const d: Dataset = {
    version: '1',
    id: newId(),
    name: input.name.trim() || 'Untitled dataset',
    owner: user.id,
    domain,
    tier: 'dataset',
    visibility: 'private',
    description: '',
    versions: emptyVersions(),
    grants: [],
    measures: [],
    columns: [],
  };
  const rec: DatasetRecord = { id: d.id, owner: d.owner, domain: d.domain, yaml: serializeDataset(d), updatedAt: now() };
  ds().store.set(rec.id, rec);
  writeThrough(rec); // best-effort durable mirror
  return d;
}

/**
 * Governed offboard support: transfer this owner's PERSONAL-lane records to a new
 * owner (used by lib/platform-admin/offboard.ts when a user is offboarded with
 * reassignment). Only personal, owner-only artifacts move; shared/domain/certified
 * are untouched. Returns the count moved.
 */
export function reassignOwner(fromId: string, toId: string): number {
  let moved = 0;
  for (const rec of ds().store.values()) {
    if (rec.owner !== fromId) continue;
    const d = parseDataset(rec.yaml);
    if (d.tier !== 'dataset') continue; // personal lane only
    // The owner lives on BOTH the record (mirror index key) and the serialized
    // yaml (which drives canView/DLS) — rewrite both so the new owner can see it.
    d.owner = toId;
    rec.owner = toId;
    rec.yaml = serializeDataset(d);
    rec.updatedAt = now();
    writeThrough(rec);
    moved++;
  }
  return moved;
}

/** Build (or pass-through) one medallion version. Editing is Creator+ on a dataset
 *  you can edit; the guided panels and the data agent both call this. */
export function buildVersion(
  id: string,
  user: Principal,
  layer: Layer,
  patch: { quality?: Quality; artifact?: string | null; passThrough?: boolean; body?: string },
): Dataset {
  const rec = get(id);
  const d = editOf(rec, user);
  const prev: VersionState = d.versions[layer];
  const next: VersionState = {
    built: true,
    passThrough: patch.passThrough ?? prev.passThrough,
    quality: patch.quality ?? (patch.passThrough ? carryQuality(d, layer) : prev.quality),
    updatedAt: now(),
    artifact: patch.artifact !== undefined ? patch.artifact : prev.artifact,
  };
  d.versions[layer] = next;
  // Store the authored native body (dbt SQL + tests) keyed by the artifact path.
  if (patch.body !== undefined && next.artifact) {
    rec.artifacts = { ...(rec.artifacts ?? {}), [next.artifact]: patch.body };
  }
  persist(rec, d, { author: user.id, summary: `build ${layer}` });
  return d;
}

/**
 * Commit a Gold JOIN build (stage-4 reuse): mark the Gold version built with its
 * compiled CTAS artifact, record the defined measures (they feed the Cube scaffold at
 * promotion — T7) and the multi-upstream lineage edges (the additional datasets the
 * join read). Editing is Creator+ on a dataset you can edit; called ONLY after the
 * Build report is ✓ (the honesty contract — no dot without a real materialized table).
 */
export function buildGoldJoin(
  id: string,
  user: Principal,
  input: { measures: Measure[]; upstreams: DatasetUpstream[]; artifact: string; body: string },
): Dataset {
  const rec = get(id);
  const d = editOf(rec, user);
  d.versions.gold = { built: true, passThrough: false, quality: 'unknown', updatedAt: now(), artifact: input.artifact };
  rec.artifacts = { ...(rec.artifacts ?? {}), [input.artifact]: input.body };
  d.measures = input.measures;
  d.upstreams = input.upstreams;
  persist(rec, d, { author: user.id, summary: 'build gold join' });
  return d;
}

/** The documentation form (data-tab-deep-design.md §Trust). Writes description +
 *  column docs (+ a requested visibility carried to promotion) into the single
 *  source. Authoring docs is Creator+ on a dataset you can edit. */
export function setDocs(
  id: string,
  user: Principal,
  docs: { description?: string; columns?: ColumnDoc[] },
): Dataset {
  const rec = get(id);
  const d = editOf(rec, user);
  if (docs.description !== undefined) d.description = docs.description;
  if (docs.columns !== undefined) {
    d.columns = docs.columns.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), description: c.description ?? '' }));
  }
  persist(rec, d, { author: user.id, summary: 'edit docs' });
  return d;
}

/**
 * Append a data-quality check to a dataset (visible + runnable in the detail view).
 * A STRUCTURED rule (`rule` + `column` + args) is EXECUTABLE — compiled to a governed
 * COUNT-of-violations SQL and run AS the owner to produce a real pass/fail (see
 * `runQualityChecks`). A bare `name`/`description` is a legacy free-text intention.
 * Editing is Creator+ on a dataset you can edit (owner or domain Admin).
 */
export function addCheck(
  id: string,
  user: Principal,
  input: {
    name?: string;
    description?: string;
    rule?: DataCheck['rule'];
    column?: string;
    values?: string[];
    min?: number;
    max?: number;
  },
): Dataset {
  const rec = get(id);
  const d = editOf(rec, user);
  const check: DataCheck = {
    id: `chk_${Math.random().toString(36).slice(2, 8)}`,
    name: (input.name ?? '').trim() || 'Untitled check',
    description: input.description ?? '',
    createdBy: user.id,
    createdAt: now(),
    ...(input.rule ? { rule: input.rule } : {}),
    ...(input.column ? { column: input.column.trim() } : {}),
    ...(input.values ? { values: input.values } : {}),
    ...(typeof input.min === 'number' ? { min: input.min } : {}),
    ...(typeof input.max === 'number' ? { max: input.max } : {}),
  };
  d.checks = [...(d.checks ?? []), check];
  persist(rec, d, { author: user.id, summary: 'add check' });
  return d;
}

/** Remove one check by id (Creator+ on a dataset you can edit). */
export function removeCheck(id: string, user: Principal, checkId: string): Dataset {
  const rec = get(id);
  const d = editOf(rec, user);
  d.checks = (d.checks ?? []).filter((c) => c.id !== checkId);
  persist(rec, d, { author: user.id, summary: 'remove check' });
  return d;
}

/** Pass-through carries the prior layer's quality forward unchanged. */
function carryQuality(d: Dataset, layer: Layer): Quality {
  if (layer === 'silver') return d.versions.bronze.quality;
  if (layer === 'gold') return d.versions.silver.quality;
  return d.versions.bronze.quality;
}

/**
 * Define a metric on the GOLD version — the Cube handover (data-ui-ux.md). Requires
 * a built Gold version AND a GOVERNED tier (asset/product): Cube reads the Trino
 * mart, so the Gold must already live in Trino (data-architecture-model.md — metrics
 * are on gold assets/products, not personal datasets). Regenerates the cube_dbt Cube
 * model + the dbt exposure artifacts so they always match the measures.
 */
export function defineMeasure(id: string, user: Principal, measure: Measure): Dataset {
  const rec = get(id);
  const d = editOf(rec, user);
  // FAIL-CLOSED metric gate (#91): a cube can only bind to a governed DOMAIN gold mart.
  // Registering a metric on un-promoted personal gold builds a broken cube (Cube's
  // `cube-*` principal can't read the personal lane). Refuse with the clear message.
  const ready = metricGoldReady(d);
  if (!ready.ok) fail(ready.message ?? 'This dataset is not ready for a metric', 400);
  if (d.measures.some((m) => m.name === measure.name)) fail(`Measure '${measure.name}' already defined`, 409);
  d.measures.push(measure);
  // Regenerate the tool-native artifacts from the updated dataset (cube_dbt + exposure).
  rec.artifacts = {
    ...(rec.artifacts ?? {}),
    [CUBE_ARTIFACT(d)]: scaffoldCubeYaml(d),
    [EXPOSURE_ARTIFACT]: scaffoldExposureYaml(d),
  };
  persist(rec, d, { author: user.id, summary: `define metric ${measure.name}` });
  return d;
}

/**
 * PHYSICALLY de-register a metric (the delete side of the Metrics lifecycle): drop a
 * defined measure from the Gold dataset. Because the Cube-models payload
 * (`/api/cube/models`, `buildCubeModels`) is built from `d.measures`, removing the
 * measure removes its Cube model member — the metric stops being queryable. Edit-scoped
 * (owner or domain admin, via {@link editOf}). Regenerates the cube_dbt/exposure
 * artifacts (or drops them when the last measure goes) so they always match the
 * measures. Returns whether a measure was actually removed so the caller can report
 * honestly. Archive (the reversible soft-hide) must NEVER call this.
 */
export function removeMeasure(id: string, user: Principal, measureName: string): { removed: boolean } {
  const rec = get(id);
  const d = editOf(rec, user);
  const before = d.measures.length;
  d.measures = d.measures.filter((m) => m.name !== measureName);
  if (d.measures.length === before) return { removed: false }; // nothing to drop
  const artifacts = { ...(rec.artifacts ?? {}) };
  if (d.measures.length > 0) {
    artifacts[CUBE_ARTIFACT(d)] = scaffoldCubeYaml(d);
    artifacts[EXPOSURE_ARTIFACT] = scaffoldExposureYaml(d);
  } else {
    // Last measure gone → the metric artifacts no longer exist for this dataset.
    delete artifacts[CUBE_ARTIFACT(d)];
    delete artifacts[EXPOSURE_ARTIFACT];
  }
  rec.artifacts = artifacts;
  persist(rec, d, { author: user.id, summary: `remove metric ${measureName}` });
  return { removed: true };
}

// ------------------------------------------------------- lifecycle (role-gated) --

/**
 * Move a dataset along the sharing lifecycle (promote/certify/unshare/decertify).
 * Separation of duties is enforced by {@link canTransition}; the storage line and
 * visibility are kept consistent. Optional grants are the policy source the compiler
 * (Phase 6) reads. Documentation / dbt-test gates are layered on in Phase 3+.
 */
export function transition(
  id: string,
  user: Principal,
  t: Transition,
  opts: { visibility?: DataVisibility; grants?: Grant[] } = {},
): Dataset {
  const rec = get(id);
  const d = parseDataset(rec.yaml);
  if (!canEdit(d, user)) fail('Not permitted to change this dataset', 403);

  const gate = canTransition(user.role, d.tier, t);
  if (!gate.ok) fail(gate.reason ?? 'transition not allowed', 403);

  // Lineage-aware: a reverse move that would orphan a published dependency is
  // refused (data-architecture-model.md §Reverse). Decertify is blocked while other
  // domains import the product; unshare is blocked while named individuals are granted.
  if (t === 'decertify' && (d.imports?.length ?? 0) > 0) {
    fail(`Cannot decertify — ${d.imports!.length} domain(s) import this product. Remove subscribers first.`, 409);
  }
  if (t === 'unshare' && d.grants.some((g) => g.grantee.kind === 'user')) {
    fail('Cannot unshare — named individuals are granted access. Revoke their grants first.', 409);
  }

  const to = tierAfter(d.tier, t);
  d.tier = to;
  d.visibility = visibilityFor(to, opts.visibility ?? d.visibility);
  if (opts.grants) d.grants = opts.grants;
  // Returning to a private dataset drops grants (nothing is shared any more).
  if (to === 'dataset') d.grants = [];
  // Decertify drops the trust badge + marketplace import list (back to an asset).
  if (t === 'decertify') { delete d.certification; delete d.imports; }

  persist(rec, d);
  return d;
}

// ----------------------------------------------- promotion (request → approve) --

export type PromotionRequest = {
  datasetId: string;
  datasetName: string;
  domain: string;
  owner: string;
  visibility: DataVisibility;
  grants: Grant[];
  target: string;
};

/**
 * A Creator REQUESTS promotion of their own dataset (separation of duties: they
 * cannot promote it themselves). We validate ownership, that there is something
 * worth promoting (a refinement beyond Bronze), and that the TRANSPARENCY GATE is
 * green — so an undocumented dataset can't even be queued. The caller enqueues the
 * returned request into the shared approvals queue; a domain Builder approves it.
 */
export function requestPromotion(
  id: string,
  user: Principal,
  opts: { visibility?: DataVisibility; grants?: Grant[] } = {},
): PromotionRequest {
  const rec = get(id);
  const d = parseDataset(rec.yaml);
  if (d.owner !== user.id) fail('Only the dataset owner can request its promotion', 403);
  if (d.tier !== 'dataset') fail('This dataset is already promoted', 409);
  if (!d.versions.silver.built && !d.versions.gold.built) {
    fail('Promote a Silver or Gold version — Bronze raw data is not shareable', 400);
  }
  const gate = transparencyGate(d);
  if (!gate.ok) fail(`Cannot promote — ${gateReason(gate)}. Complete the documentation first.`, 400);

  return {
    datasetId: d.id,
    datasetName: d.name,
    domain: d.domain,
    owner: d.owner,
    visibility: visibilityFor('asset', opts.visibility ?? 'domain'),
    grants: opts.grants ?? [{ grantee: { kind: 'domain', id: d.domain }, scope: { rows: [], columns: { mask: [], hide: [] } }, cardinality: 'low', action: 'read' }],
    target: assetTarget(d),
  };
}

/**
 * Validate an approved promotion WITHOUT applying it — every gate the apply
 * enforces (tier still pending, approver is a domain Builder/Admin, transparency
 * green), returning the parsed dataset. The physical-publish path (T8) calls this
 * FIRST, runs the real materialization, and only then flips the tier via
 * {@link applyApprovedPromotion} — so a failed CTAS can never leave a flipped tier.
 */
export function validatePromotion(req: PromotionRequest, approver: Principal): Dataset {
  const rec = get(req.datasetId);
  const d = parseDataset(rec.yaml);
  if (d.tier !== 'dataset') fail('Dataset is no longer pending promotion', 409);
  if (!approver.domains.includes(d.domain)) fail('A promotion is approved by a Builder in the dataset’s domain', 403);
  const roleGate = canTransition(approver.role, 'dataset', 'promote');
  if (!roleGate.ok) fail(roleGate.reason ?? 'promotion requires a Builder', 403);
  // Fail-closed on the approval side too: a BRONZE-only dataset is never shareable,
  // regardless of what the queued request claimed. Refine to Silver/Gold first.
  if (!d.versions.silver.built && !d.versions.gold.built) {
    fail('Promote a Silver or Gold version — Bronze raw data is not shareable', 400);
  }
  const gate = transparencyGate(d);
  if (!gate.ok) fail(`Promotion blocked — ${gateReason(gate)}`, 400);
  return d;
}

/**
 * A post-CTAS existence probe of the promoted domain table, run through the governed
 * query path. Returns whether `iceberg.<domain>.<layer>_<slug>` is queryable AS the
 * approving Builder. Injected so the pure store stays unit-testable (the server wires
 * the real Trino `tableQueryable`).
 */
export type MaterializationVerifier = (fqn: string, principal: string) => Promise<boolean>;

/**
 * Apply an APPROVED promotion. The approval IS the authorization, so ownership is
 * NOT required here — but the approver must be a domain Builder/Admin (the role
 * gate) and the transparency gate is re-checked. This is the Creator→Builder
 * handoff: the Builder's approval promotes a dataset they don't own into Trino.
 *
 * PURE registry flip — no physical I/O. The FAIL-CLOSED materialization gate (#96)
 * that guarantees the governed CTAS actually landed in the domain schema BEFORE this
 * flip lives in {@link requireDomainTableMaterialized}, which the physical publish path
 * ({@link publishApprovedPromotion}) runs first. Never call this without that check on
 * a live publish, or a tier can flip while the gold lives only in `personal_<owner>`
 * (the Northpeak gap).
 */
export function applyApprovedPromotion(req: PromotionRequest, approver: Principal): Dataset {
  const rec = get(req.datasetId);
  const d = validatePromotion(req, approver);

  d.tier = 'asset'; // storageFor(asset) === 'trino-iceberg'
  d.visibility = visibilityFor('asset', req.visibility);
  d.grants = req.grants;
  persist(rec, d);
  return d;
}

/**
 * FAIL-CLOSED materialization gate (#96): confirm the promoted domain table physically
 * exists + is queryable in the DOMAIN schema via the governed query path, BEFORE the
 * tier flips. Throws an honest 502 (tier untouched) when the governed CTAS did not land
 * `iceberg.<domain>.<layer>_<slug>` — so a promotion can NEVER flip the tier while the
 * gold lives only in `personal_<owner>` (the Northpeak gap: tier=asset but no domain
 * gold). This is a SECOND, independent probe of the exact target the caller is about to
 * flip — not a re-read of the build report — so a vacuous/mismatched build ✓ can't leak
 * an un-materialized asset through. Also the REPAIR primitive: re-run the publish CTAS
 * out-of-band, then call this to prove the domain table now resolves.
 */
export async function requireDomainTableMaterialized(
  target: string,
  approver: Principal,
  verify: MaterializationVerifier,
): Promise<void> {
  const principal = approver.domains[0] ?? approver.id;
  const live = await verify(target, principal);
  if (!live) {
    fail(
      `Promotion refused (tier unchanged) — the governed CTAS did not land ${target} in the domain schema. Re-materialize before flipping.`,
      502,
    );
  }
}

/**
 * REPAIR a promoted-but-missing asset (#96): a dataset whose tier is already
 * `asset`/`product` but whose governed gold is absent from the domain schema (a flip
 * that landed without the CTAS). The caller re-runs the publish CTAS out-of-band, then
 * calls this to CONFIRM the domain table is now queryable — throws 502 if it still
 * isn't, so a repair can't silently claim success. Idempotent: it only reads/verifies,
 * never re-flips a tier (the tier is already governed). Returns the dataset unchanged
 * on success so the caller can report an honest ✓.
 */
export async function verifyPromotedMaterialization(
  id: string,
  user: Principal,
  verify: MaterializationVerifier,
): Promise<Dataset> {
  const rec = get(id);
  const d = editOf(rec, user); // owner or domain admin — edit authority to repair
  if (d.tier === 'dataset') fail('This dataset is not promoted — nothing to re-materialize', 409);
  await requireDomainTableMaterialized(assetTarget(d), user, verify);
  return d;
}

// --------------------------------------------- certification (Admin) + import --

export type CertificationRequest = {
  datasetId: string;
  datasetName: string;
  domain: string;
  level: TrustLevel;
  visibility: DataVisibility;
};

/**
 * Certify an asset → Data Product (Admin only). Sets the OpenMetadata certification
 * trust badge, broadens visibility and lists it in the marketplace (tier `product`).
 * Admin-gated by role + domain (NOT ownership — an Admin certifies any asset in the
 * domain); the transparency gate is re-checked. Used by both the direct-Admin path
 * and the approval path.
 */
export function certify(
  id: string,
  approver: Principal,
  opts: { level?: TrustLevel; visibility?: DataVisibility; grants?: Grant[] } = {},
): Dataset {
  const rec = get(id);
  const d = parseDataset(rec.yaml);
  if (d.tier !== 'asset') fail('Only a data asset can be certified', 409);
  if (!approver.domains.includes(d.domain)) fail('Certification is by an Admin in the asset’s domain', 403);
  const roleGate = canTransition(approver.role, 'asset', 'certify'); // Admin only
  if (!roleGate.ok) fail(roleGate.reason ?? 'certification requires an Admin', 403);
  const gate = transparencyGate(d);
  if (!gate.ok) fail(`Certification blocked — ${gateReason(gate)}`, 400);

  d.tier = 'product'; // listed in the marketplace, discoverable across domains
  d.visibility = visibilityFor('product', opts.visibility ?? 'shared');
  if (opts.grants) d.grants = opts.grants;
  d.certification = { level: opts.level ?? 'gold', by: approver.id, at: now() };
  persist(rec, d);
  return d;
}

/**
 * A domain peer (owner/Builder) REQUESTS certification of an asset they can see;
 * an Admin approves it (separation of duties). Validates the asset is viewable +
 * documented. The caller enqueues this into the shared approvals queue.
 */
export function requestCertification(
  id: string,
  user: Principal,
  opts: { level?: TrustLevel; visibility?: DataVisibility } = {},
): CertificationRequest {
  const rec = get(id);
  const d = viewOf(rec, user); // must be able to see the asset
  if (d.tier !== 'asset') fail(d.tier === 'product' ? 'Already certified' : 'Promote to a data asset before certifying', 409);
  const gate = transparencyGate(d);
  if (!gate.ok) fail(`Cannot certify — ${gateReason(gate)}`, 400);
  return {
    datasetId: d.id,
    datasetName: d.name,
    domain: d.domain,
    level: opts.level ?? 'gold',
    visibility: visibilityFor('product', opts.visibility ?? 'shared'),
  };
}

/** Apply an APPROVED certification — the Admin approver certifies via {@link certify}. */
export function applyApprovedCertification(req: CertificationRequest, approver: Principal): Dataset {
  return certify(req.datasetId, approver, { level: req.level, visibility: req.visibility });
}

/**
 * Import / subscribe to a marketplace product from another domain. Records the
 * importing domain and adds a read grant — the policy compiler (Phase 6) turns this
 * into the OPA allow + Cube access for that domain. Idempotent per domain.
 */
export function importProduct(id: string, importer: Principal): Dataset {
  // Security: importing a cross-domain data product grants the WHOLE importing
  // domain read access, so it is a Builder+ action. A participant/creator is
  // blocked (403) and must ask a domain Builder/Admin — this is the real control
  // (middleware lets every /api/* through to self-guard).
  if (!roleAtLeast(importer.role, 'builder')) {
    fail('Importing a data product requires a Builder or Admin — ask a domain Builder to import it', 403);
  }
  const rec = get(id);
  const d = parseDataset(rec.yaml);
  if (d.tier !== 'product') fail('Only a certified data product can be imported', 409);
  const dom = importer.domains[0] ?? importer.id;
  if (dom === d.domain) fail('This product already belongs to your domain', 409);
  const imports = new Set(d.imports ?? []);
  if (imports.has(dom)) return d; // idempotent
  imports.add(dom);
  d.imports = [...imports];
  // The import grant the compiler reads (domain-scoped read on the product).
  if (!d.grants.some((g) => g.grantee.kind === 'domain' && g.grantee.id === dom)) {
    d.grants = [...d.grants, { grantee: { kind: 'domain', id: dom }, scope: { rows: [], columns: { mask: [], hide: [] } }, cardinality: 'low', action: 'read' }];
  }
  persist(rec, d);
  return d;
}

/** Products the user's domain has imported (the agent's `marketplace` scope, Phase 6). */
export function listImported(user: Principal): DatasetSummary[] {
  ensureSeeded();
  const out: DatasetSummary[] = [];
  for (const rec of ds().store.values()) {
    const d = parseDataset(rec.yaml);
    if (d.tier === 'product' && user.domains.some((dm) => d.imports?.includes(dm))) out.push(summarise(d));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------------------------ archive / delete -----------

/**
 * Archive a dataset: a reversible soft-hide. Edit-scoped — only the owner or an
 * in-domain Admin may archive (the same authz as editing). The record is retained;
 * the dataset just leaves the working lists (and everyone's domain/marketplace
 * lists) until unarchived.
 */
export function archiveDataset(id: string, user: Principal): DatasetSummary {
  const rec = get(id);
  const d = editOf(rec, user);
  rec.archived = true;
  rec.updatedAt = now();
  writeThrough(rec);
  return summarise(d, true);
}

/** Restore an archived dataset back into the working lists (edit-scoped). */
export function unarchiveDataset(id: string, user: Principal): DatasetSummary {
  const rec = get(id);
  const d = editOf(rec, user);
  rec.archived = false;
  rec.updatedAt = now();
  writeThrough(rec);
  return summarise(d, false);
}

/**
 * Permanently delete a dataset (edit-scoped, irreversible). A certified product
 * that other domains import is refused — remove subscribers first — so a delete can
 * never orphan a cross-domain dependency (mirrors the decertify lineage guard). The
 * API route confirms intent; this is the hard delete once confirmed. Returns the
 * deleted dataset so the route can drop its PHYSICAL tables (physical-delete.ts).
 */
export function deleteDataset(id: string, user: Principal): Dataset {
  const rec = get(id);
  const d = editOf(rec, user);
  if ((d.imports?.length ?? 0) > 0) {
    fail(`Cannot delete — ${d.imports!.length} domain(s) import this data product. Remove subscribers first.`, 409);
  }
  ds().store.delete(id);
  mirror.deleteThrough(id);
  versions.purge(id); // forget + delete-through the snapshot history
  return d;
}

// ----------------------------------------------------------- version history --

/** Version history for a dataset, newest first (view-scoped). Snapshot-backed —
 *  datasets are not git-backed, so this is the honest fallback log. */
export function listDatasetVersions(id: string, user: Principal): ArtifactVersion[] {
  const rec = get(id);
  viewOf(rec, user); // view-scoped: any viewer may see the history
  return versions.list(id);
}

/**
 * Restore a prior version of a dataset's definition (`dataset.yaml`). Auditable +
 * reversible: the CURRENT state is snapshotted as a new version FIRST, then the
 * chosen version's yaml is validated and applied. Edit-scoped (owner or domain
 * admin) — a governed state change on the same authorize/trace spine as every edit.
 */
export function restoreDatasetVersion(id: string, user: Principal, version: number): Dataset {
  const rec = get(id);
  editOf(rec, user); // edit gate (throws 403 if not permitted)
  const snap = versions.get(id, version);
  if (!snap) fail(`Version ${version} not found`, 404);
  const s = snap.state as { yaml?: string };
  if (typeof s.yaml !== 'string') fail(`Version ${version} has no restorable source`, 422);
  const restored = parseDataset(s.yaml); // validate before applying — never go live with corrupt state
  // Snapshot the live state first so the restore can itself be undone.
  versions.record(id, user.id, snapshotState(rec), `restore of v${version}`);
  rec.yaml = s.yaml;
  rec.owner = restored.owner;
  rec.domain = restored.domain;
  rec.updatedAt = now();
  writeThrough(rec);
  return restored;
}

// --------------------------------------------------------------------- files --

export type RepoFile = { path: string; content: string; sha: string };

/** Whitelisted editable paths: the single source + each built version's native file. */
export function listFiles(id: string, user: Principal): { files: string[]; dataset: Dataset } {
  const d = viewOf(get(id), user);
  const files = ['dataset.yaml'];
  for (const l of ['bronze', 'silver', 'gold'] as Layer[]) {
    const a = d.versions[l].artifact;
    if (a) files.push(a);
  }
  // Metric artifacts (cube_dbt model + dbt exposure) appear once a measure exists.
  if (d.measures.length > 0) files.push(CUBE_ARTIFACT(d), EXPOSURE_ARTIFACT);
  return { files, dataset: d };
}

export function readFile(id: string, user: Principal, path: string): RepoFile {
  const rec = get(id);
  const d = viewOf(rec, user);
  if (path === 'dataset.yaml') {
    const content = serializeDataset(d);
    return { path, content, sha: sha(content) };
  }
  const isVersion = (['bronze', 'silver', 'gold'] as Layer[]).some((l) => d.versions[l].artifact === path);
  const isMetric = d.measures.length > 0 && (path === CUBE_ARTIFACT(d) || path === EXPOSURE_ARTIFACT);
  if (!isVersion && !isMetric) fail(`Path '${path}' is not part of this dataset`, 404);
  // The authored/generated body if present; otherwise a stub the live adapter
  // (Phase 6) materialises on Build.
  const content = rec.artifacts?.[path] ?? `-- ${path} (native artifact; body materialised by the Build adapter)\n`;
  return { path, content, sha: sha(content) };
}

export function writeFile(id: string, user: Principal, input: { path: string; content: string; sha: string }): RepoFile {
  const rec = get(id);
  const d = editOf(rec, user);
  if (input.path !== 'dataset.yaml') fail(`Path '${input.path}' is materialised by Build, not hand-edited here`, 403);
  const current = serializeDataset(d);
  if (input.sha && input.sha !== sha(current)) fail('The file changed since you opened it (stale sha) — reload', 409);
  const next = parseDataset(input.content); // throws on bad shape
  persist(rec, next);
  return { path: 'dataset.yaml', content: rec.yaml, sha: sha(rec.yaml) };
}
