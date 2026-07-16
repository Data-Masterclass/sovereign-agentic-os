/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Dataset } from '@/lib/data';
import { goldMartFqn, slug } from '@/lib/data/metrics';
import {
  type OmConn,
  type OmPatchOp,
  type OmWrite,
  buildAdditivePatch,
  omVersionWritable,
} from '@/lib/data';

/**
 * Phase 2 — SCOPED, INTEGRITY-SAFE write-back of OS-produced assets into a
 * customer's existing OpenMetadata. ADDITIVE ONLY: the OS is authoritative for the
 * entities it PRODUCES and NEVER mutates a field it did not author. This engine
 * computes an additive plan (no I/O), renders an honest diff, and executes ONLY
 * after governance approval — with an optimistic-concurrency yield.
 *
 * The seven guards (from the approved design):
 *  1. Namespace isolation — OS physical assets under the dedicated Database Service
 *     `sovereign_os`; OS Data Products under the dedicated Domain `Sovereign OS
 *     Products`. Only PUT-create happens INSIDE this namespace ({@link OS_SERVICE},
 *     {@link OS_DOMAIN}); a plan that targets anything else is rejected.
 *  2. Additive JSON-Patch only on any shared/human entity — `add`/`replace`/`test`
 *     via {@link buildAdditivePatch} (no `remove`, EVER); a description is written
 *     only behind a `test` that the field is currently empty.
 *  3. `managedBy=SovereignOS` markers on everything OS-created/touched; on re-sync a
 *     human-owned entity (managedBy != SovereignOS) is annotate-only.
 *  4. Idempotency — keyed on `osDatasetId` + FQN; PUT is create-or-update; a lineage
 *     edge PUT is a no-op when it already exists.
 *  5. Optimistic concurrency — read the entity `version`/`updatedBy` before a PATCH;
 *     a human edit since our last sync makes us YIELD (record a conflict); the
 *     JSON-Patch `test` precondition fails-closed at OM (412) as defence in depth.
 *  6. Dry-run / preview diff BEFORE write — {@link buildOmSyncPlan} +
 *     {@link previewOmSync} render the exact PUT bodies + patch ops with ZERO
 *     writes; {@link applyOmSync} runs only after approval (Write-approval mode).
 *  7. OM-side RBAC — the writer bot's OM Role/Policy allows write only on the
 *     `sovereign_os` Service + the OS Domain + the `SovereignOS` classification
 *     (provisioned by {@link provisionOmNamespace} / the chart Job).
 */

// --- The dedicated OS namespace (Guard 1) --------------------------------------
/** The dedicated OM Database Service every OS physical asset lands under. */
export const OS_SERVICE = 'sovereign_os';
/** The dedicated OM Domain every OS Data Product lands under. */
export const OS_DOMAIN = 'Sovereign OS Products';
/** The OS classification whose tags are the ONLY tags OS may add to a shared table. */
export const OS_CLASSIFICATION = 'SovereignOS';
/** The custom-property keys the OS stamps to mark provenance (Guard 3). */
export const MANAGED_BY = 'SovereignOS';
export const OS_PROPS = ['managedBy', 'osDatasetId', 'osDomain', 'osRunId'] as const;

/** The database + schema OS tables live in, under the OS service. Iceberg gold marts
 *  map to `sovereign_os.<domain>.gold_<slug>` so the OS namespace mirrors the domain
 *  layout without ever touching the customer's own Trino service. */
function osTableFqn(d: Dataset): string {
  return `${OS_SERVICE}.${d.domain}.gold_${slug(d.name)}`;
}
/** The OM Data Product FQN under the OS Domain (products only). */
function osProductFqn(d: Dataset): string {
  return `${OS_DOMAIN}.${slug(d.name)}`;
}

// --- The plan (pure — no I/O) --------------------------------------------------

/** A create-or-update of ONE entity INSIDE the OS namespace (Guard 1). */
export type OmPutOp = {
  kind: 'table' | 'dataProduct';
  /** OM REST path to PUT to (a `PUT .../<entityType>` create-or-update). */
  path: string;
  /** The entity FQN — asserted to live in the OS namespace before any write. */
  fqn: string;
  body: Record<string, unknown>;
};

/** An additive JSON-Patch against a possibly-SHARED entity (Guard 2). `targetFqn`
 *  is a human-visible label; `entityPath` is the OM REST path patched. */
export type OmPatchTarget = {
  entityPath: string;
  targetFqn: string;
  /** Why this patch is additive-safe (shown in the diff). */
  note: string;
  ops: OmPatchOp[];
};

/** An additive lineage edge (Guard 4 — idempotent). */
export type OmEdgeOp = { fromFqn: string; toFqn: string; note: string };

export type OmSyncPlan = {
  osDatasetId: string;
  osDomain: string;
  osRunId: string;
  /** PUT create-or-updates, ALL inside the OS namespace. */
  puts: OmPutOp[];
  /** Additive JSON-Patches on shared entities (tags/props/description-if-empty). */
  patches: OmPatchTarget[];
  /** Additive lineage edges. */
  edges: OmEdgeOp[];
  /** Set when the plan cannot be built safely (e.g. not a promotable asset). */
  rejected?: string;
};

/** The managed-by custom properties every OS entity carries (Guard 3). */
function managedProps(d: Dataset, runId: string): Record<string, string> {
  return { managedBy: MANAGED_BY, osDatasetId: d.id, osDomain: d.domain, osRunId: runId };
}

/**
 * Build the ADDITIVE sync plan for one OS dataset/product — NO I/O. Maps:
 *   • an OS Data Product (tier=product) → an OM Data Product under {@link OS_DOMAIN};
 *   • the governed Gold mart → an OM table under the {@link OS_SERVICE} service;
 *   • OS lineage (refinement + consumption edges from `lib/data/lineage`) → additive
 *     OM lineage edges among the OS-namespace entities;
 *   • an optional additive PATCH that STAMPS the customer's own catalogued copy of
 *     the mart (the human-visible Trino table) with the OS classification tag +
 *     managedBy props — behind `test` preconditions so no human field is overwritten.
 * Every op carries `managedBy=SovereignOS`. A dataset with no built Gold, or one that
 * is not yet a governed asset/product, is REJECTED (nothing to publish safely).
 */
export function buildOmSyncPlan(
  d: Dataset,
  opts: { runId: string; humanServiceFqn?: string },
): OmSyncPlan {
  const runId = opts.runId;
  const base: OmSyncPlan = { osDatasetId: d.id, osDomain: d.domain, osRunId: runId, puts: [], patches: [], edges: [] };

  if (!d.versions.gold.built) {
    return { ...base, rejected: 'The Gold layer is not built — nothing to publish into OpenMetadata.' };
  }
  if (d.tier === 'dataset') {
    return { ...base, rejected: 'Only a promoted asset/product syncs to OpenMetadata — promote this dataset to Shared first.' };
  }

  const props = managedProps(d, runId);
  const extension = { ...props } as Record<string, unknown>;
  const columns = d.columns.map((c) => ({ name: c.name, dataType: 'UNKNOWN', description: c.description || undefined }));

  // Guard 1 — the OS gold mart as an OM table INSIDE the sovereign_os service.
  const tableFqn = osTableFqn(d);
  const puts: OmPutOp[] = [
    {
      kind: 'table',
      path: '/api/v1/tables',
      fqn: tableFqn,
      body: {
        name: `gold_${slug(d.name)}`,
        databaseSchema: `${OS_SERVICE}.${d.domain}`,
        description: d.description || undefined,
        columns,
        extension,
      },
    },
  ];

  // Guard 1 — an OS Data Product under the OS Domain, for a product-tier dataset.
  if (d.tier === 'product') {
    puts.push({
      kind: 'dataProduct',
      path: '/api/v1/dataProducts',
      fqn: osProductFqn(d),
      body: {
        name: slug(d.name),
        displayName: d.name,
        domain: OS_DOMAIN,
        description: d.description || undefined,
        extension,
      },
    });
  }

  // Guard 4 — additive lineage edges among the OS-namespace entities. We only emit
  // edges whose BOTH endpoints are OS-authored (the OS table / product), so we never
  // assert an edge onto a human entity we did not create. Cross-namespace upstream
  // edges are left to OM's own crawler (never asserted here) to keep the write scoped.
  const edges: OmEdgeOp[] = [];
  if (d.tier === 'product') {
    edges.push({ fromFqn: tableFqn, toFqn: osProductFqn(d), note: 'gold mart → OS data product (consumption)' });
  }

  // Guard 2/3 — OPTIONAL additive PATCH on the customer's OWN catalogued mart (the
  // human-visible Trino table), IF the operator told us its OM FQN. We add the OS
  // classification tag + the managedBy props ONLY — each behind a `test` precondition
  // so a concurrent human edit fails the patch closed (412 → yield). We NEVER touch
  // the description of a human table here (that field is theirs); description is only
  // authored on the OS-namespace table above.
  const patches: OmPatchTarget[] = [];
  if (opts.humanServiceFqn) {
    const humanFqn = `${opts.humanServiceFqn}.${goldMartFqn(d).replace(/^iceberg\./, '')}`;
    patches.push({
      entityPath: `/api/v1/tables/name/${encodeURIComponent(humanFqn)}`,
      targetFqn: humanFqn,
      note: 'add SovereignOS tag + managedBy props (additive; no human field overwritten)',
      ops: buildAdditivePatch([
        // Precondition: the tags array exists (OM always initialises it) — additive add.
        { op: 'add', path: '/tags/-', value: { tagFQN: `${OS_CLASSIFICATION}.Managed`, source: 'Classification' } },
        // Stamp provenance in the extension (custom properties) — replace only our OWN
        // keys, each guarded so we never clobber a human-authored extension value.
        { op: 'test', path: `/extension/managedBy`, value: undefined },
        { op: 'add', path: '/extension/managedBy', value: MANAGED_BY },
        { op: 'add', path: '/extension/osDatasetId', value: d.id },
        { op: 'add', path: '/extension/osRunId', value: runId },
      ]),
    });
  }

  return { ...base, puts, patches, edges };
}

// --- The preview (honest diff — no I/O) ----------------------------------------

export type OmSyncPreview = {
  ok: boolean;
  osDatasetId: string;
  summary: string;
  /** Rendered, human-readable lines of exactly what WILL happen. */
  lines: string[];
  counts: { creates: number; patches: number; edges: number; humanFieldsTouched: 0 };
  rejected?: string;
};

/**
 * Render the honest diff for a plan — ZERO writes (Guard 6). Always states that
 * ZERO human fields are touched (the plan only PUTs inside the OS namespace and
 * only ADDS tags/props behind `test` guards). The `humanFieldsTouched` count is a
 * structural constant `0` — the plan cannot express a human-field overwrite.
 */
export function previewOmSync(plan: OmSyncPlan): OmSyncPreview {
  if (plan.rejected) {
    return {
      ok: false,
      osDatasetId: plan.osDatasetId,
      summary: plan.rejected,
      lines: [],
      counts: { creates: 0, patches: 0, edges: 0, humanFieldsTouched: 0 },
      rejected: plan.rejected,
    };
  }
  const lines: string[] = [];
  for (const p of plan.puts) lines.push(`create/update ${p.kind} ${p.fqn} (under ${OS_SERVICE}/${OS_DOMAIN}, managedBy=${MANAGED_BY})`);
  for (const pt of plan.patches) lines.push(`annotate ${pt.targetFqn}: ${pt.note}`);
  for (const e of plan.edges) lines.push(`add lineage edge ${e.fromFqn} → ${e.toFqn} (${e.note})`);
  const summary =
    `Will create ${plan.puts.length} entit${plan.puts.length === 1 ? 'y' : 'ies'} under ${OS_SERVICE}/${OS_DOMAIN}, ` +
    `add ${plan.edges.length} lineage edge${plan.edges.length === 1 ? '' : 's'}, ` +
    `annotate ${plan.patches.length} existing table${plan.patches.length === 1 ? '' : 's'} additively — ` +
    `touch ZERO human fields.`;
  return {
    ok: true,
    osDatasetId: plan.osDatasetId,
    summary,
    lines,
    counts: { creates: plan.puts.length, patches: plan.patches.length, edges: plan.edges.length, humanFieldsTouched: 0 },
  };
}

// --- The apply (executes the plan through an injected client) ------------------

/** The minimal per-connection client surface the apply step needs. Injected so the
 *  engine is unit-tested against a FAKE OM with zero network. Real callers pass the
 *  live client bound to a resolved connection (writer bot token + OM version). */
export type OmSyncClient = {
  /** GET an entity's `{ version, updatedBy }` for the optimistic-concurrency check
   *  (Guard 5). Returns null when the entity does not exist yet (a fresh create). */
  readEntityMeta: (entityPath: string) => Promise<{ version?: number; updatedBy?: string } | null>;
  putEntity: (path: string, body: unknown) => Promise<OmWrite>;
  patchEntity: (entityPath: string, ops: OmPatchOp[]) => Promise<OmWrite>;
  putLineage: (edge: { fromFqn: string; toFqn: string }) => Promise<OmWrite>;
  /** The OM version this connection speaks (for the write-range refusal, Guard). */
  omVersion?: string;
};

export type OmSyncResult = {
  ok: boolean;
  applied: { creates: number; patches: number; edges: number };
  /** Human-owned entities we YIELDED on rather than overwrite (Guard 5). */
  conflicts: { targetFqn: string; reason: string }[];
  /** Non-conflict failures (unreachable / version refusal / bad shape). */
  errors: string[];
  refused?: string;
};

/**
 * Execute the plan through the injected client — ONLY call this AFTER governance
 * approval (Guard 6; the MCP `apply_om_sync` tool holds it as Write-approval).
 *
 * Guard 5 (optimistic concurrency): before each PATCH we read the target's meta;
 * the JSON-Patch already carries `test` preconditions, but we ALSO record a human
 * edit as a conflict and skip rather than depend solely on OM's 412. A PUT inside
 * the OS namespace is idempotent (Guard 4) so it is always safe to (re-)send.
 */
export async function applyOmSync(
  client: OmSyncClient,
  plan: OmSyncPlan,
  opts: { lastSyncUpdatedBy?: string } = {},
): Promise<OmSyncResult> {
  const result: OmSyncResult = { ok: true, applied: { creates: 0, patches: 0, edges: 0 }, conflicts: [], errors: [] };

  if (plan.rejected) return { ...result, ok: false, refused: plan.rejected };
  if (!omVersionWritable(client.omVersion)) {
    return { ...result, ok: false, refused: `OM version ${client.omVersion ?? 'unknown'} is outside the tested write range — refusing to write.` };
  }

  // Guard 1 — hard assert every PUT target lives in the OS namespace. A plan that
  // somehow targets a human FQN is REFUSED wholesale (never a partial write).
  for (const p of plan.puts) {
    if (!p.fqn.startsWith(`${OS_SERVICE}.`) && !p.fqn.startsWith(`${OS_DOMAIN}.`)) {
      return { ...result, ok: false, refused: `Plan PUT targets a non-OS-namespace entity (${p.fqn}) — refusing.` };
    }
  }

  // Idempotent create-or-update inside the OS namespace (Guard 4).
  for (const p of plan.puts) {
    const w = await client.putEntity(p.path, p.body);
    if (w.ok) result.applied.creates += 1;
    else { result.errors.push(`PUT ${p.fqn}: ${w.reason}`); result.ok = false; }
  }

  // Additive PATCHes on shared/human entities — with the optimistic-concurrency
  // yield (Guard 5) layered on top of the JSON-Patch `test` preconditions (Guard 2).
  for (const pt of plan.patches) {
    const meta = await client.readEntityMeta(pt.entityPath);
    // A human edited since our last sync → YIELD (do not overwrite). We detect this
    // by a change in `updatedBy` vs the last OS sync's recorded writer.
    if (meta && opts.lastSyncUpdatedBy && meta.updatedBy && meta.updatedBy !== opts.lastSyncUpdatedBy && meta.updatedBy !== MANAGED_BY) {
      result.conflicts.push({ targetFqn: pt.targetFqn, reason: `human edit by ${meta.updatedBy} since last sync — yielded` });
      continue;
    }
    const w = await client.patchEntity(pt.entityPath, pt.ops);
    if (w.ok) result.applied.patches += 1;
    else if (w.conflict) result.conflicts.push({ targetFqn: pt.targetFqn, reason: w.reason });
    else { result.errors.push(`PATCH ${pt.targetFqn}: ${w.reason}`); result.ok = false; }
  }

  // Additive, idempotent lineage edges (Guard 4).
  for (const e of plan.edges) {
    const w = await client.putLineage({ fromFqn: e.fromFqn, toFqn: e.toFqn });
    if (w.ok) result.applied.edges += 1;
    else { result.errors.push(`lineage ${e.fromFqn}→${e.toFqn}: ${w.reason}`); result.ok = false; }
  }

  return result;
}

// --- Provisioning (idempotent onboarding — Guard 1 + 7) ------------------------

/** The idempotent provisioning steps run on first write: create the OS Service,
 *  the OS Domain, the OS classification, the custom-property definitions. Each is a
 *  PUT create-or-update so re-running is a no-op (Guard 4). The least-privilege
 *  writer bot Role/Policy (Guard 7) is provisioned by the chart Job (it needs OM
 *  admin creds the app never holds) — this server fn provisions the entity shells. */
export type OmProvisionStep = { path: string; body: Record<string, unknown>; what: string };

export function omProvisionPlan(): OmProvisionStep[] {
  const customProps = OS_PROPS.map((name) => ({ name, description: `SovereignOS provenance marker: ${name}` }));
  return [
    { path: '/api/v1/services/databaseServices', what: `Database Service ${OS_SERVICE}`, body: { name: OS_SERVICE, serviceType: 'CustomDatabase', description: 'Sovereign OS — OS-produced physical assets (additive, integrity-safe).' } },
    { path: '/api/v1/domains', what: `Domain "${OS_DOMAIN}"`, body: { name: OS_DOMAIN, domainType: 'Aggregate', description: 'Sovereign OS — OS-produced Data Products.' } },
    { path: '/api/v1/classifications', what: `Classification ${OS_CLASSIFICATION}`, body: { name: OS_CLASSIFICATION, description: 'Tags applied by Sovereign OS (Managed). OS may add only tags under this classification.' } },
    { path: '/api/v1/metadata/types/customProperties', what: `custom properties (${OS_PROPS.join(', ')})`, body: { entityType: 'table', properties: customProps } },
  ];
}

/**
 * Provision the OS namespace shells idempotently through an injected PUT client.
 * Safe to call on first write; re-running is a no-op. REFUSES on an out-of-range
 * OM version. Returns which steps applied vs failed — never throws.
 */
export async function provisionOmNamespace(
  put: (path: string, body: unknown) => Promise<OmWrite>,
  omVersion?: string,
): Promise<{ ok: boolean; applied: string[]; errors: string[]; refused?: string }> {
  if (!omVersionWritable(omVersion)) {
    return { ok: false, applied: [], errors: [], refused: `OM version ${omVersion ?? 'unknown'} outside tested write range — refusing to provision.` };
  }
  const applied: string[] = [];
  const errors: string[] = [];
  for (const step of omProvisionPlan()) {
    const w = await put(step.path, step.body);
    if (w.ok) applied.push(step.what);
    else errors.push(`${step.what}: ${w.reason}`);
  }
  return { ok: errors.length === 0, applied, errors };
}

/** Bind a resolved {@link OmConn} into the {@link OmSyncClient} the apply step needs.
 *  Kept here (not in the pure client) because it composes the read + write verbs. */
export function syncClientFrom(
  conn: OmConn,
  verbs: {
    readEntityMeta: OmSyncClient['readEntityMeta'];
    putEntity: OmSyncClient['putEntity'];
    patchEntity: OmSyncClient['patchEntity'];
    putLineage: OmSyncClient['putLineage'];
  },
): OmSyncClient {
  return { ...verbs, omVersion: conn.omVersion };
}
