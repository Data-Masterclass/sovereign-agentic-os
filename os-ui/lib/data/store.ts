/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type Role, roleAtLeast } from '../session.ts';
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
import { CUBE_ARTIFACT, EXPOSURE_ARTIFACT, scaffoldCubeYaml, scaffoldExposureYaml } from './metrics.ts';
import { assetTarget, productTarget, personalSchema, domainSchema, slug } from './store-fqn.ts';
import { config } from '../config.ts';
import { osMirror } from '../os-mirror.ts';

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

function persist(rec: DatasetRecord, d: Dataset): DatasetRecord {
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

/**
 * The physical Trino FQN of a dataset's built medallion layer, resolved tier-aware:
 * a private `dataset` lives in the caller's OWN `personal_<uid>` schema, a governed
 * asset/product in its domain schema — the SAME resolution {@link listAskable} uses, so
 * a governed row preview targets exactly the table the ask/query surface would. Returns
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
  // A private `dataset` lives in the OWNER's personal lane and must be READ AS the
  // owner (personal_<uid> ownership); a governed asset/product lives in its domain
  // schema, read as the domain principal. domainSchema() keeps a hyphenated domain a
  // VALID Trino identifier (raw `agentic-leader-q3-2026` is a SYNTAX_ERROR).
  const personal = d.tier === 'dataset';
  const schema = personal ? personalSchema(user.id) : domainSchema(d.domain);
  const principal = personal ? user.id : (user.domains[0] ?? user.id);
  return { layer: chosen, fqn: `iceberg.${schema}.${chosen}_${slug(d.name)}`, principal };
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
  persist(rec, d);
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
  persist(rec, d);
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
  persist(rec, d);
  return d;
}

/**
 * Append a data-quality check intention to a dataset (visible in the detail view).
 * Checks are RECORDED alongside the dataset.yaml spine — they are NOT auto-executed;
 * connect a data quality tool (dbt tests, Great Expectations, etc.) to run them.
 * Editing is Creator+ on a dataset you can edit (owner or domain Admin).
 */
export function addCheck(
  id: string,
  user: Principal,
  input: { name: string; description: string },
): Dataset {
  const rec = get(id);
  const d = editOf(rec, user);
  const check: DataCheck = {
    id: `chk_${Math.random().toString(36).slice(2, 8)}`,
    name: input.name.trim() || 'Untitled check',
    description: input.description ?? '',
    createdBy: user.id,
    createdAt: now(),
  };
  d.checks = [...(d.checks ?? []), check];
  persist(rec, d);
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
  if (!d.versions.gold.built) fail('Define a metric only on a built Gold version', 400);
  if (d.tier === 'dataset') {
    fail('Define a metric on a governed Gold asset/product — promote it first (Cube reads the Trino mart)', 400);
  }
  if (d.measures.some((m) => m.name === measure.name)) fail(`Measure '${measure.name}' already defined`, 409);
  d.measures.push(measure);
  // Regenerate the tool-native artifacts from the updated dataset (cube_dbt + exposure).
  rec.artifacts = {
    ...(rec.artifacts ?? {}),
    [CUBE_ARTIFACT(d)]: scaffoldCubeYaml(d),
    [EXPOSURE_ARTIFACT]: scaffoldExposureYaml(d),
  };
  persist(rec, d);
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
  const gate = transparencyGate(d);
  if (!gate.ok) fail(`Promotion blocked — ${gateReason(gate)}`, 400);
  return d;
}

/**
 * Apply an APPROVED promotion. The approval IS the authorization, so ownership is
 * NOT required here — but the approver must be a domain Builder/Admin (the role
 * gate) and the transparency gate is re-checked. This is the Creator→Builder
 * handoff: the Builder's approval promotes a dataset they don't own into Trino.
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
  return d;
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
