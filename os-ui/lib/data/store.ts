/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type Role, roleAtLeast } from '../core/session.ts';
import { canManageArtifact, type ArtifactScope } from '../governance/edit-scope.ts';
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
  type GoldSpec,
  type DataCheck,
  type DatasetSync,
  type ConnectedSource,
  DATASET_SYNC_MODES,
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
import { CUBE_ARTIFACT, EXPOSURE_ARTIFACT, scaffoldCubeYaml, scaffoldExposureYaml, metricSqlReady, metricCubeReady } from './metrics.ts';
import { SEMANTIC_ARTIFACT, scaffoldSemanticYaml } from './semantic.ts';
import { assetTarget, productTarget, reuseSourceFqn, personalSchema, domainSchema, physicalSlug, versionTarget } from './store-fqn.ts';
import { config } from '../core/config.ts';
import { osMirror } from '../infra/os-mirror.ts';
import { type ArtifactVersion, versionLog } from '../core/versioning.ts';
// The GOVERNED folder registry (Wave 1) — a moved-into folder is upserted as an
// explicit row so it persists even when empty. Reused, never forked (mirrors Files).
import { createFolder, type FolderScope, type Principal as FolderPrincipal } from '../folders/index.ts';
import { normaliseFolderPath } from '../core/folders.ts';
import { isValidCron } from '../agents/cron-util.ts';

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
  /** The FROZEN physical slug (absent ⇒ derivable from `name`). Carried on the summary
   *  so summary-driven FQN builders (catalog) stay pinned to the physical table across a
   *  rename — resolve it via `physicalSlug(summary)`. */
  slug?: string;
  owner: string;
  domain: string;
  tier: Tier;
  visibility: DataVisibility;
  /** The folder this dataset lives in (normalised path; `'/'` = root). */
  folder: string;
  /** Furthest built medallion layer, or null if nothing built. */
  freshness: string | null;
  quality: Quality;
  /** B/S/G dots for the tile. */
  dots: { bronze: boolean; silver: boolean; gold: boolean };
  storage: ReturnType<typeof storageFor>;
  /** Soft-archived (retained, reversible). Absent/false = live. */
  archived?: boolean;
  /** VISIBLE STALE STATE (Northpeak fix): the promoted domain table holds a prior
   *  snapshot (source rebuilt, publish CTAS not yet re-run). Absent = in sync. */
  domainTableStale?: boolean;
  /** Born curated (composed from existing datasets) — drives the tile's transparency
   *  badge. Absent = ingested. */
  curated?: boolean;
  /** Adopted from a warehouse connection (origin:'connected'). Present ⇒ the tile shows a
   *  "connected" badge and its live status; drives the metric-source exclusion. Absent =
   *  not a connected dataset. */
  connected?: { mode: 'live' | 'sync'; status: 'ok' | 'drifted' | 'source-revoked' };
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

/**
 * Test hook: insert a dataset with a FIXED id, owner, domain, tier and columns
 * directly into the in-process store. Real datasets are born through the governed
 * flows (createDataset → buildVersion → …) with a minted id, so tests that need a
 * SPECIFIC production id (e.g. the Northpeak `ds_zpco1s6n7y` the demo-app seed
 * guards on) cannot reproduce it through the public API. This is the minimal,
 * test-only door for exactly that — additive, `__`-prefixed like `__resetStore`,
 * and never referenced by production code paths.
 */
export function __seedDatasetForTest(input: {
  id: string;
  name: string;
  owner: string;
  domain: string;
  tier?: Tier;
  columns?: ColumnDoc[];
}): void {
  ensureSeeded();
  const d: Dataset = {
    version: '1',
    id: input.id,
    name: input.name,
    owner: input.owner,
    domain: input.domain,
    tier: input.tier ?? 'dataset',
    visibility: input.tier === 'asset' ? 'domain' : input.tier === 'product' ? 'public' : 'private',
    folder: '/',
    description: '',
    versions: emptyVersions(),
    grants: [],
    measures: [],
    columns: input.columns ?? [],
    cubeNamespaced: true,
  };
  const rec: DatasetRecord = { id: d.id, owner: d.owner, domain: d.domain, yaml: serializeDataset(d), updatedAt: now() };
  ds().store.set(rec.id, rec);
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
  // Fail-closed edit-scope: owner always; a PRIVATE (dataset-tier) dataset is
  // owner-only — no admin/domain_admin may touch another user's private data. A
  // shared (asset) / product dataset admits an in-domain domain_admin or admin.
  const scope: ArtifactScope = d.tier === 'dataset' ? 'personal' : d.tier === 'product' ? 'certified' : 'shared';
  return canManageArtifact(user, { owner: d.owner, domain: d.domain, scope });
}

/**
 * The PROMOTE/APPROVE governance authority (separate from private-artifact
 * management). Promotion is the sanctioned path by which a Builder/Admin SHARES a
 * dataset — so even for a still-Personal (dataset-tier) dataset it admits an
 * in-domain domain_admin or a platform admin, NOT owner-only. The role/tier
 * separation-of-duties is enforced additionally by {@link canTransition}. Keeping
 * this on the pre-existing (scope-agnostic) rule preserves the promotion gates the
 * manage-rights change must NOT alter. */
function canGovern(d: Dataset, user: Principal): boolean {
  return canManageArtifact(user, { owner: d.owner, domain: d.domain, scope: 'shared' });
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

/**
 * Metric-definition scope — DISTINCT from a structural edit. Defining/removing a
 * measure is additive semantic-layer work on a governed domain gold mart (the Metrics
 * tab is built for Builders to do exactly this), not a change to the dataset's core
 * (silver/gold rebuild, docs, promotion, delete — those stay owner/domain_admin/admin
 * via {@link editOf}). So a metric only needs: you can USE the data (canView) and you
 * are a Builder+. This restores the pre-0.1.95 "builders define metrics" behaviour that
 * the edit-scope tightening accidentally blocked for shared-in-domain datasets.
 */
function metricScopeOf(rec: DatasetRecord, user: Principal): Dataset {
  const d = parseDataset(rec.yaml);
  if (!canView(d, user)) fail('Not permitted to view this dataset', 403);
  // The OWNER may always define a metric on their own dataset (building their own
  // work); anyone else needs Builder+ to add a metric to a dataset they can use.
  if (d.owner !== user.id && !roleAtLeast(user.role, 'builder')) {
    fail('Defining a metric requires a Builder or Admin', 403);
  }
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

/**
 * Cross-domain governance move (admin-only, gated in lib/platform-admin/domain-move.ts).
 * A dataset carries its domain in BOTH the record field AND its canonical yaml
 * (scoping parses the yaml), so we parse → set d.domain → persist, which
 * re-serializes the yaml and stamps rec.domain together — the store's own
 * discipline, not a partial poke. `sel.id` moves one; `sel.onlyUnassigned`
 * sweeps only empty-domain records. Returns the ids moved.
 */
export function moveDatasetsDomain(sel: { id?: string; onlyUnassigned?: boolean }, target: string): string[] {
  const moved: string[] = [];
  for (const rec of ds().store.values()) {
    if (sel.id !== undefined && rec.id !== sel.id) continue;
    if (sel.onlyUnassigned && rec.domain) continue;
    if (rec.domain === target) continue;
    const d = parseDataset(rec.yaml);
    d.domain = target;
    persist(rec, d);
    moved.push(rec.id);
  }
  return moved;
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
    ...(d.slug ? { slug: d.slug } : {}),
    owner: d.owner,
    domain: d.domain,
    tier: d.tier,
    visibility: d.visibility,
    folder: d.folder,
    freshness: f.freshness,
    quality: built ? built.quality : 'unknown',
    dots: { bronze: d.versions.bronze.built, silver: d.versions.silver.built, gold: d.versions.gold.built },
    storage: storageFor(d.tier),
    archived,
    ...(d.domainTableStale ? { domainTableStale: true } : {}),
    ...(d.origin === 'curated' ? { curated: true } : {}),
    ...(d.origin === 'connected' && d.connected
      ? { connected: { mode: d.connected.mode, status: d.connected.status } }
      : {}),
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
    // this tab's "Company" tier; a private dataset (owner-only, via canView) under Personal.
    // STRICT DOMAIN ISOLATION (platform-admin model): EVERY tier — My, Domain AND Company —
    // narrows to the ACTIVE domain for EVERYONE incl the owner/admin (canView returns true
    // for the owner regardless of domain, so without this an owner sees their domain-A
    // artifacts while acting in domain B). "All Domains" = every membership → shown; a
    // domainless (unassigned) artifact always shows. Cross-domain discovery of a certified
    // product happens ONLY through the dedicated Marketplace catalog surface, never here.
    const inScope = !d.domain || user.domains.includes(d.domain);
    if (d.tier === 'product') { if (inScope) marketplace.push(summarise(d, rec.archived)); }
    else if (d.tier === 'asset') { if (inScope) domain.push(summarise(d, rec.archived)); }
    else if (inScope) mine.push(summarise(d, rec.archived));
  }
  const byName = (a: DatasetSummary, b: DatasetSummary) => a.name.localeCompare(b.name);
  return { mine: mine.sort(byName), domain: domain.sort(byName), marketplace: marketplace.sort(byName) };
}

export function getDataset(id: string, user: Principal): Dataset {
  return viewOf(get(id), user);
}

/** UNSCOPED existence+name peek for the software dataset-reference guard (no authz):
 *  "does this dataset id exist in the world, and what is it called?" — used ONLY to tell a
 *  DELETED dataset (rebuild/restore) apart from an EXISTS-but-ungranted one (grant it).
 *  No rows, no per-viewer detail — just the display name or null. An ARCHIVED dataset still
 *  EXISTS (archived ≠ deleted), so a present record ⇒ non-null. */
export function peekDatasetMeta(id: string): { name: string } | null {
  ensureSeeded();
  const rec = ds().store.get(id);
  if (!rec) return null;
  try { return { name: parseDataset(rec.yaml).name }; } catch { return { name: '' }; }
}

/** UNSCOPED tier peek for the declarative AppSpec validator (0.6.116): "is this dataset
 *  Personal (owner-only) or a governed asset/product?" — used to WARN when a spec sources a
 *  Personal dataset (readable only by its owner, so other app users get access-denied →
 *  promote-to-Domain). Non-throwing: an absent or unparseable record ⇒ null (fail-soft; the
 *  caller skips the warning rather than emitting a false one). No authz, no rows. */
export function peekDatasetTier(id: string): Tier | null {
  ensureSeeded();
  const rec = ds().store.get(id);
  if (!rec) return null;
  try { return parseDataset(rec.yaml).tier; } catch { return null; }
}

/** UNSCOPED column-name peek for the declarative AppSpec validator (0.6.116): the dataset's
 *  documented column names, so the validator can verify every spec `field`/`keyField` exists
 *  and LIST the real columns in the fix hint — the highest-value teaching signal. Non-throwing
 *  and unscoped (consistent with `peekDatasetMeta`): an absent or unparseable record ⇒ null
 *  (fail-soft; the caller skips the column check rather than flagging a false unknown). */
export function peekDatasetColumns(id: string): string[] | null {
  ensureSeeded();
  const rec = ds().store.get(id);
  if (!rec) return null;
  try { return parseDataset(rec.yaml).columns.map((c) => c.name); } catch { return null; }
}

/** UNSCOPED measure-name peek for the metric-existence check behind the AppSpec validator
 *  (0.6.116). A metric IS a measure on a dataset (`datasetId.measure`), so existence is
 *  "the dataset exists and declares this measure". Non-throwing: absent/unparseable ⇒ null. */
export function peekDatasetMeasureNames(id: string): string[] | null {
  ensureSeeded();
  const rec = ds().store.get(id);
  if (!rec) return null;
  try { return parseDataset(rec.yaml).measures.map((m) => m.name); } catch { return null; }
}

/**
 * The soft-archive flag is a RECORD-level property (`DatasetRecord.archived`), not
 * part of the yaml-derived {@link Dataset}. The detail view needs it to show
 * Restore instead of Archive, so expose it view-scoped alongside `getDataset`.
 */
export function isDatasetArchived(id: string, user: Principal): boolean {
  const rec = get(id);
  viewOf(rec, user); // authz: caller must be allowed to see it
  return !!rec.archived;
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
  // CONNECTED · LIVE branch FIRST (lakehouse-import-exposure.md, Phase 2). An adopted live
  // dataset federates its ONE declared tier straight to the external `catalog.schema.table`;
  // there is no bronze and no domain/personal copy. A revoked source resolves to NO fqn
  // (null) so preview/profile/Talk answer a calm "source revoked" instead of a doomed read.
  // The principal is ALWAYS the viewer's domain principal — the personal lane never applies.
  if (d.connected && d.connected.mode === 'live') {
    if (d.connected.status === 'source-revoked') return null;
    const chosenLive: Layer = d.connected.tier;
    const fqn = versionTarget(d, chosenLive, { id: user.id });
    const principal = user.domains[0] ?? user.id;
    return { layer: chosenLive, fqn, principal };
  }
  // CONNECTED · SYNC branch (lakehouse-import-exposure.md, Phase 3). An adopted sync dataset
  // reads its GOVERNED COPY at the declared tier from the domain schema (`versionTarget`
  // resolves it) — but ONLY once the FIRST landing has verified (earned status: the tier
  // version is `built`). Before that there is no table yet → null (calm "not synced yet").
  // A source-revoked sync dataset KEEPS its last-landed copy (sovereign data): it still
  // resolves so preview/Talk/metrics read the frozen table — the UI banners the freeze. The
  // read runs AS the viewer's domain principal, matching the domain-schema copy.
  if (d.connected && d.connected.mode === 'sync') {
    const chosenSync: Layer = d.connected.tier;
    if (!d.versions[chosenSync]?.built) return null;
    const fqn = versionTarget(d, chosenSync, { id: user.id });
    const principal = user.domains[0] ?? user.id;
    return { layer: chosenSync, fqn, principal };
  }
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

/**
 * UNSCOPED single-dataset read for the sync scheduler (mirrors the agents store's
 * `systemForScheduler`): a CronJob trigger carries no human session, so the executor
 * loads the record by id, then resolves the OWNER's live identity and runs AS them.
 * Server-side callers only — never expose through a user-facing route.
 */
export function datasetForScheduler(id: string): Dataset | null {
  ensureSeeded();
  const rec = ds().store.get(id);
  if (!rec || rec.archived) return null;
  return parseDataset(rec.yaml);
}

/** UNSCOPED list of live datasets with a sync configured — the fallback sweep's
 *  worklist (`/api/data/sync-due`). Server-side callers only. */
export function datasetsWithSync(): Dataset[] {
  ensureSeeded();
  const out: Dataset[] = [];
  for (const rec of ds().store.values()) {
    if (rec.archived) continue;
    const d = parseDataset(rec.yaml);
    if (d.sync) out.push(d);
  }
  return out;
}

/** A dataset the caller may JOIN into a Gold build (stage-4 reuse). */
export type JoinableDataset = { id: string; name: string; domain: string; tier: Tier; fqn: string; columns: string[] };

/**
 * The canView- AND active-domain-scoped list of OTHER datasets the caller can reuse in
 * a Gold join: only governed tiers (asset/product) they may READ (never a private
 * dataset they don't own), narrowed to the operating domain, that actually have a
 * physical table (silver/gold built). Same gates as the catalog/list — the join picker
 * can never surface a dataset the caller's active domain doesn't hold, and the route
 * re-checks `getDataset` per pick as defense in depth.
 */
export function listJoinable(user: Principal, excludeId?: string): JoinableDataset[] {
  ensureSeeded();
  const out: JoinableDataset[] = [];
  for (const rec of ds().store.values()) {
    const d = parseDataset(rec.yaml);
    if (d.id === excludeId) continue;
    // Personal (My-tier) datasets are reusable ONLY by their OWNER — you may compose a
    // curated dataset from your OWN private datasets (no cross-user exposure; the join
    // reads your personal lane AS you), but never from someone else's owner-only data.
    // Shared (asset) / Company (product) tiers stay open to everyone who canView.
    if (d.tier === 'dataset' && d.owner !== user.id) continue;
    if (!canView(d, user)) continue; // the hard visibility gate
    // ACTIVE-DOMAIN NARROWING (the same inScope gate the main list applies to all
    // tiers): canView alone leaks across domains — an owner/admin passes it for their
    // OTHER domains' assets, and a certified product is canView-true tenant-wide. The
    // join picker must only offer what the operating domain holds; cross-domain
    // discovery of a certified product happens ONLY through the Marketplace catalog,
    // never here. (Leak seen live 2026-07-31: kiekert datasets offered in the JOIN TO
    // dropdown while operating in agentic-leader.)
    if (d.domain && !user.domains.includes(d.domain)) continue;
    if (!d.versions.gold.built && !d.versions.silver.built) continue; // must be materialized
    out.push({ id: d.id, name: d.name, domain: d.domain, tier: d.tier, fqn: reuseSourceFqn(d), columns: d.columns.map((c) => c.name) });
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
    // ACTIVE-DOMAIN NARROWING (the same inScope gate listDatasets/listJoinable apply):
    // canView alone leaks across domains — the owner passes it for their OTHER domains'
    // datasets, and a certified product is canView-true tenant-wide. Talk-to-Data's
    // evidence must only cite what the operating domain holds (leak seen live
    // 2026-08-02: all-domain datasets listed as evidence under a single active domain).
    if (d.domain && !user.domains.includes(d.domain)) continue;
    const f = furthest(d);
    if (!f.layer) continue; // nothing materialized — nothing to query
    const schema = d.tier === 'dataset' ? personalSchema(user.id) : domainSchema(d.domain);
    out.push({
      id: d.id,
      name: d.name,
      domain: d.domain,
      tier: d.tier,
      fqn: `iceberg.${schema}.${f.layer}_${physicalSlug(d)}`,
      description: d.description,
      columns: d.columns,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------------------------------------- create / edit --

export function createDataset(user: Principal, input: { name: string; domain?: string; origin?: 'ingest' | 'curated' }): Dataset {
  ensureSeeded();
  const domain = input.domain && user.domains.includes(input.domain) ? input.domain : user.domains[0] ?? 'platform';
  const wanted = (input.name.trim() || 'Untitled dataset').toLowerCase();
  // Name uniqueness WITHIN a domain: a dataset name maps to ONE domain gold table
  // (`gold_<slug>`) and ONE Cube model file, so two same-named datasets in a domain
  // collide — the model-sync sidecar overwrites one with the other and a defined measure
  // silently vanishes ("metric did not resolve"). Refuse the duplicate at the source with
  // a clear message. Cross-domain the SAME name is now SAFE (#155): new datasets carry a
  // domain-namespaced cube identity (`<domain>__<slug>`), so two domains' "Sales" no longer
  // share one cube/view/model file — hence this guard stays deliberately within-domain.
  for (const rec of ds().store.values()) {
    if (rec.domain !== domain) continue;
    if (parseDataset(rec.yaml).name.trim().toLowerCase() === wanted) {
      fail(`A dataset named “${input.name.trim()}” already exists in ${domain} — pick a unique name.`, 409);
    }
  }
  const d: Dataset = {
    version: '1',
    id: newId(),
    name: input.name.trim() || 'Untitled dataset',
    owner: user.id,
    domain,
    tier: 'dataset',
    visibility: 'private',
    folder: '/',
    description: '',
    versions: emptyVersions(),
    grants: [],
    measures: [],
    columns: [],
    // #155: every NEW dataset gets the domain-namespaced cube identity. Existing datasets
    // (no marker) keep their legacy un-namespaced name — so live Cube models are untouched.
    cubeNamespaced: true,
    // TWO-PATH create: only the curated birth is recorded (absent ⇒ ingest, byte-stable).
    ...(input.origin === 'curated' ? { origin: 'curated' as const } : {}),
  };
  const rec: DatasetRecord = { id: d.id, owner: d.owner, domain: d.domain, yaml: serializeDataset(d), updatedAt: now() };
  ds().store.set(rec.id, rec);
  writeThrough(rec); // best-effort durable mirror
  return d;
}

/**
 * ADOPT an exposed connection table as a governed dataset (lakehouse-import-exposure.md,
 * Phase 2). Unlike {@link createDataset}, an adopted dataset is born at DOMAIN tier
 * (`asset`, visibility `domain`) — exposure (Company/admin) + adoption (domain_admin) are
 * the two governance gates, so it lands governed, not in the personal lane. `origin` is
 * `'connected'` with the `connected` block the FQN seam (`builtLayerFqn`/`versionTarget`)
 * branches on: a LIVE dataset federates every read straight to `<catalog>.<schema>.<table>`
 * with NO bronze and NO domain copy — so ONLY `versions[tier].built` is set true (the
 * declared tier's dot), and it carries the at-adopt description straight into the yaml.
 *
 * The ROLE GATE (domain_admin) + the exposure→domain intersection are enforced by the
 * caller (`resolveAdoptableExposure` in the route) — this store action trusts the resolved
 * `domain`/`catalog`/`connected` it is handed and only enforces the shape (name uniqueness,
 * a non-empty description). Pure: audit `trace()` is fired at the route, like adoption's
 * exposure-CRUD sibling.
 */
export function adoptConnectedDataset(
  user: Principal,
  input: {
    name: string;
    domain: string;
    description: string;
    connected: ConnectedSource;
    /** SYNC-mode adoption (Phase 3): the sync config to attach. The engine lands a governed
     *  copy into `iceberg.<domain>.<tier>_<slug>`; the tier version stays UNBUILT until the
     *  first successful landing verifies (earned status). Ignored for live-mode adoptions. */
    sync?: DatasetSync;
  },
): Dataset {
  ensureSeeded();
  const domain = input.domain || user.domains[0] || 'platform';
  const name = input.name.trim() || input.connected.source.table;
  const description = input.description.trim();
  // A short description is REQUIRED at adopt time (feeds the documentation gate). Refuse an
  // empty one honestly — never adopt an undocumented external table.
  if (!description) fail('A short description is required to adopt a connected table.', 400);
  const wanted = name.toLowerCase();
  for (const rec of ds().store.values()) {
    if (rec.domain !== domain) continue;
    if (parseDataset(rec.yaml).name.trim().toLowerCase() === wanted) {
      fail(`A dataset named “${name}” already exists in ${domain} — pick a unique name.`, 409);
    }
  }
  const isSync = input.connected.mode === 'sync';
  // LIVE: the declared tier's version is immediately "built" (federated) — the FQN seam
  // resolves the external table. SYNC: no version is built yet — the tier lights (EARNED)
  // only after the first successful landing, so `builtLayerFqn` returns "not synced yet"
  // until real data lands. Bronze never exists for a connected dataset either way.
  const versions = emptyVersions();
  const tierLayer: Layer = input.connected.tier; // 'silver' | 'gold'
  if (!isSync) {
    versions[tierLayer] = { built: true, passThrough: false, quality: 'unknown', updatedAt: now(), artifact: null };
  }

  const d: Dataset = {
    version: '1',
    id: newId(),
    name,
    owner: user.id,
    domain,
    // DOMAIN tier from birth (the approved decision): a governed asset, domain-visible.
    tier: 'asset',
    visibility: 'domain',
    folder: '/',
    description,
    versions,
    grants: [],
    measures: [],
    columns: [],
    cubeNamespaced: true,
    origin: 'connected',
    connected: input.connected,
    // A sync-mode adoption carries its sync config from birth (the scheduler lands the copy).
    ...(isSync && input.sync ? { sync: input.sync } : {}),
  };
  const rec: DatasetRecord = { id: d.id, owner: d.owner, domain: d.domain, yaml: serializeDataset(d), updatedAt: now() };
  ds().store.set(rec.id, rec);
  writeThrough(rec);
  return d;
}

/**
 * REVOCATION PROPAGATION (lakehouse-import-exposure.md, Phase 2 + 3). When an exposure is
 * revoked, every dataset bound to it (`connected.exposureId`) is frozen honestly:
 *   • LIVE datasets — `connected.status` flips to `'source-revoked'` so the FQN seam
 *     returns no table (calm "source revoked" everywhere), and preview/Talk render the
 *     banner.
 *   • SYNC datasets — the SOVEREIGN DATA is kept: the last-landed governed copy stays in
 *     the domain schema (`versions[tier].built` is left true), but the sync is DISABLED and
 *     the per-dataset CronJob removed (`reconcileSyncCron(id, null)`), so no further landing
 *     runs. Status still flips to `'source-revoked'` — the Source stage banners "copy frozen
 *     as of <last successful run>" while preview/Talk/metrics keep reading the frozen table.
 * Returns the affected datasets (id + name + owner) so the route can notify each owner +
 * trace per dataset. Idempotent: an already-revoked binding is left untouched (not
 * re-notified). Server-side (scheduler-style, UNSCOPED) — the revoke path has no per-dataset
 * session. The CronJob teardown happens in the (server-only) CALLER for entries flagged
 * `syncFrozen` — importing sync-cron here (even dynamically) drags the k8s client
 * (node:fs/https) into webpack's client graph via store.ts and breaks the production build.
 * The frozen copy is already sovereign, so a teardown hiccup never loses data.
 */
export function markDatasetsSourceRevoked(exposureId: string): { id: string; name: string; owner: string; domain: string; syncFrozen: boolean }[] {
  ensureSeeded();
  const affected: { id: string; name: string; owner: string; domain: string; syncFrozen: boolean }[] = [];
  for (const rec of ds().store.values()) {
    if (rec.archived) continue;
    const d = parseDataset(rec.yaml);
    if (d.origin !== 'connected' || !d.connected) continue;
    if (d.connected.exposureId !== exposureId) continue;
    if (d.connected.status === 'source-revoked') continue; // already frozen — don't re-notify
    d.connected = { ...d.connected, status: 'source-revoked' };
    // SYNC freeze: disable the sync and tear down its CronJob so no further landing runs —
    // the last-landed copy is kept untouched (the tier version stays `built`). LIVE datasets
    // have no sync/CronJob, so this is a no-op for them.
    const wasSyncEnabled = d.connected.mode === 'sync' && !!d.sync;
    if (wasSyncEnabled && d.sync) {
      d.sync = { ...d.sync, enabled: false };
    }
    rec.yaml = serializeDataset(d);
    rec.updatedAt = now();
    writeThrough(rec);
    affected.push({ id: d.id, name: d.name, owner: d.owner, domain: d.domain, syncFrozen: wasSyncEnabled });
  }
  return affected;
}

/**
 * DRIFT PROPAGATION: when a catalog snapshot diff removes/changes a bound table, mark every
 * live dataset bound to that connection+table `'drifted'` (still readable, warned). Only
 * flips `ok → drifted` (never overrides `source-revoked`, the stronger state). Returns the
 * affected datasets. Server-side, UNSCOPED (the snapshot refresh has no per-dataset session).
 */
export function markDatasetsDrifted(
  connectionId: string,
  removed: { schema: string; table: string }[],
): { id: string; name: string; owner: string }[] {
  ensureSeeded();
  const removedKeys = new Set(removed.map((t) => `${t.schema}.${t.table}`));
  const affected: { id: string; name: string; owner: string }[] = [];
  for (const rec of ds().store.values()) {
    if (rec.archived) continue;
    const d = parseDataset(rec.yaml);
    if (d.origin !== 'connected' || !d.connected) continue;
    if (d.connected.connectionId !== connectionId) continue;
    if (d.connected.status !== 'ok') continue; // don't downgrade revoked or re-flag drifted
    if (!removedKeys.has(`${d.connected.source.schema}.${d.connected.source.table}`)) continue;
    d.connected = { ...d.connected, status: 'drifted' };
    rec.yaml = serializeDataset(d);
    rec.updatedAt = now();
    writeThrough(rec);
    affected.push({ id: d.id, name: d.name, owner: d.owner });
  }
  return affected;
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
  // Northpeak fix (materialization drift): rebuilding the PUBLISHED layer (or building a
  // gold above a silver-published asset) of an ALREADY-PROMOTED dataset rewrites only the
  // owner's personal lane — the governed domain copy now holds a prior snapshot (or lacks
  // the new layer entirely). Flag it STALE until the publish CTAS re-runs. Bronze builds
  // (incl. sync freshness marks) don't touch the domain copy directly and stay unflagged.
  if (d.tier !== 'dataset' && layer !== 'bronze') d.domainTableStale = true;
  persist(rec, d, { author: user.id, summary: `build ${layer}` });
  return d;
}

/**
 * Commit a Gold JOIN build (stage-4 reuse): mark the Gold version built with its
 * compiled CTAS artifact, record the defined measures (they feed the Cube scaffold at
 * promotion — T7) and the multi-upstream lineage edges (the additional datasets the
 * join read). Editing is Creator+ on a dataset you can edit; called ONLY after the
 * Build report is ✓ (the honesty contract — no dot without a real materialized table).
 *
 * `goldSpec` (optional) is the RAW editable build spec — persisted so the panel
 * re-hydrates the joins/columns/measures and the definition stays editable + rebuildable.
 * A rebuild REPLACES it (the last successful spec is the current one). `upstreams` may be
 * EMPTY for a single-table Gold (no join partner) — the version still lights.
 */
export function buildGoldJoin(
  id: string,
  user: Principal,
  input: { measures: Measure[]; upstreams: DatasetUpstream[]; artifact: string; body: string; goldSpec?: GoldSpec },
): Dataset {
  const rec = get(id);
  const d = editOf(rec, user);
  d.versions.gold = { built: true, passThrough: false, quality: 'unknown', updatedAt: now(), artifact: input.artifact };
  rec.artifacts = { ...(rec.artifacts ?? {}), [input.artifact]: input.body };
  // Measures are declared in the PUBLISH stage now (the Gold panel builds a row-level
  // projection and always sends none) — a gold rebuild must never wipe them. Only a
  // build that explicitly brings measures (e.g. the MCP tool) replaces the list.
  if (input.measures.length) d.measures = input.measures;
  d.upstreams = input.upstreams;
  if (input.goldSpec) d.goldSpec = input.goldSpec;
  // Northpeak fix (materialization drift): if this dataset is ALREADY promoted, the
  // governed domain table (`iceberg.<domain>.gold_<slug>`) — the FQN Cube + every consumer
  // reads — is now a PRIOR snapshot: this rebuild only rewrote the owner's personal-lane
  // Gold. Flag it STALE so the domain copy is honestly known to be behind until the publish
  // CTAS re-runs (auto-refreshed by a builder+ rebuilder in the route, else surfaced + re-promoted).
  if (d.tier !== 'dataset') d.domainTableStale = true;
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
  opts: { provenance?: 'ai-auto' } = {},
): Dataset {
  const rec = get(id);
  const d = editOf(rec, user);
  if (docs.description !== undefined) d.description = docs.description;
  if (docs.columns !== undefined) {
    d.columns = docs.columns.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), description: c.description ?? '' }));
  }
  // PROVENANCE: an AI auto-doc write STAMPS 'ai-auto' (so the UI shows "AI-drafted —
  // review…"). Any OTHER setDocs — every human save through the docs route — CLEARS the
  // marker, so a reviewed/edited doc drops it. Attribute the auto write in the audit log
  // ('ai-auto-docs') so the version history reads honestly.
  d.docsProvenance = opts.provenance === 'ai-auto' ? 'ai-auto' : undefined;
  persist(rec, d, { author: opts.provenance === 'ai-auto' ? 'ai-auto-docs' : user.id, summary: 'edit docs' });
  return d;
}

/**
 * Rename a dataset — change its DISPLAY name ONLY. Edit-scoped exactly like every
 * other mutation (owner always; an in-domain domain_admin / platform admin on a
 * shared/certified dataset — the reused {@link canManageArtifact} gate).
 *
 * CRITICAL — the physical identity NEVER moves: the physical table / Cube / dbt name
 * is derived from the FROZEN `slug`, so BEFORE we touch the name we PIN `d.slug` to the
 * dataset's CURRENT physical slug (`physicalSlug(d)` = the existing frozen slug if it was
 * already renamed once, else `slug(oldName)`). From then on `physicalSlug` returns that
 * pinned value regardless of the display name, so every FQN/cube/dbt path stays put and
 * no live Iceberg table is ever orphaned. The name is then set + persisted + versioned.
 *
 * Within-domain name uniqueness is re-checked (same rule as {@link createDataset}) so a
 * rename can't collide two datasets onto one shared cube/model file.
 */
export function renameDataset(id: string, user: Principal, newName: string): Dataset {
  const rec = get(id);
  const d = editOf(rec, user);
  const name = newName.trim();
  if (!name) fail('a dataset needs a name', 400);
  if (name === d.name) return d; // no-op → no version churn, no slug freeze
  // Re-enforce within-domain uniqueness (a rename must not collide onto another's slug).
  const wanted = name.toLowerCase();
  for (const other of ds().store.values()) {
    if (other.id === id || other.domain !== d.domain) continue;
    if (parseDataset(other.yaml).name.trim().toLowerCase() === wanted) {
      fail(`A dataset named “${name}” already exists in ${d.domain} — pick a unique name.`, 409);
    }
  }
  // FREEZE the physical slug to the CURRENT table BEFORE the name changes, then rename.
  d.slug = physicalSlug(d); // pin: existing frozen slug, else slug(oldName)
  d.name = name;
  persist(rec, d, { author: user.id, summary: 'rename' });
  return d;
}

/**
 * Move a dataset into a folder (edit-scoped, versioned/write-through like every other
 * mutation). Mirrors `lib/files/store.moveFile`: the folder is a normalised path on the
 * dataset's single source; the folder ROOT (personal vs domain tree) is decided by tier.
 * On move we also upsert an EXPLICIT folder row in the governed registry so the
 * destination folder persists even when it holds no datasets. A viewer who cannot edit
 * is rejected 403 and nothing is written.
 */
export function moveDataset(id: string, user: Principal, folder: string): Dataset {
  const rec = get(id);
  const d = editOf(rec, user);
  d.folder = normaliseFolderPath(folder);
  persist(rec, d, { author: user.id, summary: 'edit folder' });
  // The move already passed the dataset's edit-scope gate above, so this same-owner
  // folder create can only mirror an authorised move (best-effort; never rolls it back).
  upsertFolderRow(d, user);
  return d;
}

/** The folder scope a dataset lives in: a private (dataset) tile's folders are the
 *  owner's PERSONAL tree; a shared (asset) / marketplace (product) tile's folders are
 *  the owning DOMAIN's tree. Mirrors how `listDatasets` groups by tier. */
function folderScopeOf(d: Dataset): FolderScope {
  return d.tier === 'dataset' ? 'personal' : 'domain';
}

/** Best-effort: mirror a dataset's folder path into the governed folder registry so an
 *  empty folder still shows in the rail. The root is implicit (never a row). createFolder
 *  is idempotent and edit-scoped; any gate failure is swallowed so a successful move is
 *  never rolled back by a folder-registry hiccup (mirrors Files' upsertFolderRow). */
function upsertFolderRow(d: Dataset, user: Principal): void {
  const path = normaliseFolderPath(d.folder);
  if (path === '/') return;
  const principal: FolderPrincipal = { id: user.id, role: user.role, domains: user.domains };
  try {
    createFolder(principal, { tab: 'data', scope: folderScopeOf(d), path, domain: d.domain });
  } catch {
    /* folder-registry mirror is best-effort; the dataset move already succeeded */
  }
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

/** Set the human-readable DESCRIPTIONS of existing checks by id (Creator+ on a dataset
 *  you can edit). Only the description text is touched — the executable rule (rule/column/
 *  args) is never changed here. Unknown ids are ignored; a trimmed-empty description clears
 *  the field. This is the persist path behind "Save Data Quality Checks" for edited or
 *  AI-drafted descriptions. */
export function updateCheckDescriptions(
  id: string,
  user: Principal,
  updates: { id: string; description: string }[],
): Dataset {
  const rec = get(id);
  const d = editOf(rec, user);
  const byId = new Map(updates.map((u) => [u.id, (u.description ?? '').trim()]));
  d.checks = (d.checks ?? []).map((c) => (byId.has(c.id) ? { ...c, description: byId.get(c.id)! } : c));
  persist(rec, d, { author: user.id, summary: 'describe checks' });
  return d;
}

/**
 * Toggle a heuristic monitor (freshness/volume/schema) on a dataset (Creator+ on a
 * dataset you can edit). Default-ON: only an explicit `false` is retained; flipping one
 * back on drops it from the config so an all-on dataset stays byte-stable in the yaml.
 */
export function setMonitor(
  id: string,
  user: Principal,
  kind: 'freshness' | 'volume' | 'schema',
  enabled: boolean,
): Dataset {
  const rec = get(id);
  const d = editOf(rec, user);
  const next = { ...(d.monitors ?? {}) };
  if (enabled) delete next[kind];
  else next[kind] = false;
  d.monitors = Object.keys(next).length > 0 ? next : undefined;
  persist(rec, d, { author: user.id, summary: `${enabled ? 'enable' : 'disable'} ${kind} monitor` });
  return d;
}

/**
 * Configure (or clear, with `null`) a dataset's SCHEDULED INCREMENTAL SYNC. The strict
 * validation gate: the tolerant schema parse never rejects, so every invariant an
 * executable sync needs is enforced HERE — valid cron, a cursor for incremental modes,
 * merge keys for merge mode. Edit scope is the same owner/domain_admin/admin gate every
 * structural edit uses ({@link editOf}). CronJob reconciliation is the caller's job
 * (`sync-cron.ts`) — this only persists the definition.
 */
export function setDatasetSync(id: string, user: Principal, sync: DatasetSync | null): Dataset {
  const rec = get(id);
  const d = editOf(rec, user);
  if (sync) {
    if (!sync.connectionId) fail('sync: connectionId required', 400);
    if (!sync.source?.schema || !sync.source?.table) fail('sync: source schema + table required', 400);
    if (!DATASET_SYNC_MODES.includes(sync.mode)) fail(`sync: invalid mode '${String(sync.mode)}'`, 400);
    if (!isValidCron(sync.schedule?.cron)) {
      fail('sync: invalid cron expression — expected 5 fields (e.g. "0 6 * * *")', 400);
    }
    if (sync.mode !== 'full-refresh') {
      if (!sync.cursor?.column) fail(`sync: ${sync.mode} mode requires a cursor column`, 400);
      if (sync.cursor.kind !== 'timestamp' && sync.cursor.kind !== 'number' && sync.cursor.kind !== 'kafka-offsets') {
        fail(`sync: cursor kind '${sync.cursor.kind}' is not implemented yet (timestamp|number|kafka-offsets)`, 400);
      }
    }
    // Kafka offset sync is APPEND-ONLY (streams have no stable key to merge on, and
    // replacing an unbounded topic copy is the reset ACTION, not a schedule mode).
    if (sync.cursor?.kind === 'kafka-offsets' && sync.mode !== 'append') {
      fail('sync: kafka-offsets cursors support append mode only', 400);
    }
    if (sync.mode === 'merge' && (!sync.mergeKeys || sync.mergeKeys.length === 0)) {
      fail('sync: merge mode requires at least one merge key', 400);
    }
    d.sync = sync;
  } else {
    delete d.sync;
  }
  persist(rec, d, { author: user.id, summary: sync ? 'configure sync' : 'remove sync' });
  return d;
}

/** Pass-through carries the prior layer's quality forward unchanged. */
function carryQuality(d: Dataset, layer: Layer): Quality {
  if (layer === 'silver') return d.versions.bronze.quality;
  if (layer === 'gold') return d.versions.silver.quality;
  return d.versions.bronze.quality;
}

/**
 * Define a metric on the GOLD version. Since the metrics→Trino migration (Phase 1) a metric
 * is a VIRTUAL DECLARATION served as governed Trino SQL over the physical gold mart, read AS
 * the viewer — so defining one requires ONLY a BUILT Gold, of ANY tier (a personal dataset's
 * metric reads its own personal lane). We always emit the portable MetricFlow-style SEMANTIC
 * declaration; the Cube model + dbt exposure artifacts are emitted ONLY for a CUBE-ready
 * (governed) dataset, so a broken cube is never registered on personal gold (#91 preserved).
 */
export function defineMeasure(id: string, user: Principal, measure: Measure): Dataset {
  const rec = get(id);
  const d = metricScopeOf(rec, user);
  // SQL-READY gate: define/serve need only a built Gold (any tier) — the metric serves as
  // governed Trino SQL run AS the viewer. Refuse a dataset with no built Gold honestly.
  const ready = metricSqlReady(d);
  if (!ready.ok) fail(ready.message ?? 'This dataset is not ready for a metric', 400);
  // Define is an UPSERT keyed by the measure name (a metric's frozen physical identity is
  // its Cube member `${View}.${name}` — there is never two same-named measures on one
  // dataset). A re-save of an existing measure name is an EDIT of THAT metric: replace it
  // IN PLACE (preserving order + its DISPLAY `label`, which the define form never carries),
  // never a false "already defined" 409. A new name appends.
  const at = d.measures.findIndex((m) => m.name === measure.name);
  if (at >= 0) {
    const existing = d.measures[at];
    d.measures[at] = existing.label ? { ...measure, label: existing.label } : measure;
  } else {
    d.measures.push(measure);
  }
  // The portable MetricFlow-style semantic declaration is ALWAYS emitted (it is served as
  // Trino SQL, works on personal gold). The cube_dbt model + dbt exposure are CUBE artifacts
  // — emit them ONLY when the dataset is cube-ready (governed), never on personal gold where
  // the cube's `cube-*` principal can't read the personal lane (#91 fail-closed preserved).
  const artifacts: Record<string, string> = {
    ...(rec.artifacts ?? {}),
    [SEMANTIC_ARTIFACT(d)]: scaffoldSemanticYaml(d),
  };
  if (metricCubeReady(d).ok) {
    artifacts[CUBE_ARTIFACT(d)] = scaffoldCubeYaml(d);
    artifacts[EXPOSURE_ARTIFACT] = scaffoldExposureYaml(d);
  }
  rec.artifacts = artifacts;
  persist(rec, d, { author: user.id, summary: `${at >= 0 ? 'update' : 'define'} metric ${measure.name}` });
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
  const d = metricScopeOf(rec, user);
  const before = d.measures.length;
  d.measures = d.measures.filter((m) => m.name !== measureName);
  if (d.measures.length === before) return { removed: false }; // nothing to drop
  const artifacts = { ...(rec.artifacts ?? {}) };
  if (d.measures.length > 0) {
    artifacts[SEMANTIC_ARTIFACT(d)] = scaffoldSemanticYaml(d);
    // Cube artifacts only for a cube-ready (governed) dataset — never registered on personal gold.
    if (metricCubeReady(d).ok) {
      artifacts[CUBE_ARTIFACT(d)] = scaffoldCubeYaml(d);
      artifacts[EXPOSURE_ARTIFACT] = scaffoldExposureYaml(d);
    }
  } else {
    // Last measure gone → the metric artifacts no longer exist for this dataset.
    delete artifacts[SEMANTIC_ARTIFACT(d)];
    delete artifacts[CUBE_ARTIFACT(d)];
    delete artifacts[EXPOSURE_ARTIFACT];
  }
  rec.artifacts = artifacts;
  persist(rec, d, { author: user.id, summary: `remove metric ${measureName}` });
  return { removed: true };
}

/**
 * Rename a metric's DISPLAY name — set the measure's `label` while FREEZING `measure.name`.
 * A metric IS a measure on a governed dataset, so its physical identity is the Cube member
 * `${View}.${measure.name}`; changing `name` would move that member (and its sql/semantic
 * declaration), orphaning every consumer. So — exactly like a dataset rename freezes its
 * physical slug — we write only the `label` and leave `name` (hence the member + Cube
 * artifacts) untouched. No artifact regeneration: the semantic/cube YAML key off `name`,
 * which is unchanged. Edit-scoped (owner or in-domain admin, via {@link editOf}).
 */
export function setMeasureLabel(id: string, user: Principal, measureName: string, label: string): Dataset {
  const rec = get(id);
  const d = editOf(rec, user);
  const m = d.measures.find((x) => x.name === measureName);
  if (!m) fail(`Measure '${measureName}' not found`, 404);
  m.label = label;
  persist(rec, d, { author: user.id, summary: `rename metric ${measureName}` });
  return d;
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
  // Promote/approve governance authority — NOT the owner-only private-manage gate,
  // so a Builder/Admin can still SHARE a Personal dataset (unchanged promotion gate).
  if (!canGovern(d, user)) fail('Not permitted to change this dataset', 403);

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
  // #146: a governed shared asset becomes part of the analytics-as-code estate —
  // mark it git-backed so the promote hook records its dbt model + schema.yml in the
  // `analytics` mono-repo (observability mirror; the runtime CTAS is unchanged). The
  // flag is sticky + persisted (parseDataset carries it forward through certify).
  d.gitBacked = true;
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
  // The domain table now resolves → it is in sync with the source again. Clear the STALE
  // marker (idempotent: no-op when it was never set) so consumers stop being warned.
  if (d.domainTableStale) {
    delete d.domainTableStale;
    persist(rec, d, { author: user.id, summary: 're-materialize: domain table confirmed in sync' });
  }
  return d;
}

/** Clear the STALE-domain-table marker after a confirmed re-materialization (the publish
 *  CTAS re-ran + the domain probe passed). Gated like a promotion approval — the OWNER or
 *  any BUILDER+ in the dataset's domain (the same people who may run the refresh CTAS) —
 *  NOT the narrower edit scope, so the approving Builder who just re-materialized can
 *  honestly clear the drift they fixed. Idempotent: a no-op when the flag was never set. */
export function clearDomainTableStale(id: string, user: Principal): Dataset {
  const rec = get(id);
  const d = parseDataset(rec.yaml);
  const inDomain = user.domains.includes(d.domain);
  const mayClear = d.owner === user.id || (inDomain && roleAtLeast(user.role, 'builder'));
  if (!mayClear) fail('Clearing the stale marker requires the owner or a Builder in the dataset’s domain', 403);
  if (d.domainTableStale) {
    delete d.domainTableStale;
    persist(rec, d, { author: user.id, summary: 're-materialize: domain table refreshed' });
  }
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
  // Metric artifacts appear once a measure exists: the portable MetricFlow semantic
  // declaration always; the cube_dbt model + dbt exposure only for a cube-ready (governed)
  // dataset (they aren't emitted on personal gold).
  if (d.measures.length > 0) {
    files.push(SEMANTIC_ARTIFACT(d));
    if (metricCubeReady(d).ok) files.push(CUBE_ARTIFACT(d), EXPOSURE_ARTIFACT);
  }
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
  const isMetric = d.measures.length > 0 && (path === SEMANTIC_ARTIFACT(d) || path === CUBE_ARTIFACT(d) || path === EXPOSURE_ARTIFACT);
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
