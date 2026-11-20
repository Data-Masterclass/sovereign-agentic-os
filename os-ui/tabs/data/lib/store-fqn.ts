/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, Layer } from '@tabs/data/lib/dataset-schema';

/**
 * The canonical FQN helpers (the handover contract — one name threaded downstream).
 * Extracted from the store so the pure policy compiler can reference the SAME names
 * the store/promotion use, without importing the stateful registry.
 */

export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'dataset';
}

/**
 * The FROZEN physical slug of a dataset — the ONE stable identity every physical
 * derivation (Iceberg FQN, Cube name/view, dbt model path) must be built from.
 *
 * It returns the dataset's pinned `slug` when set, else falls back to `slug(name)`.
 * This is the decoupling contract: a dataset that has NEVER been renamed carries no
 * `slug` field and resolves to `slug(name)` unchanged (byte-stable, zero migration);
 * a RENAMED dataset carries a `slug` pinned to its CURRENT physical table at the moment
 * of rename, so its FQN/cube/dbt identity NEVER moves when the display name changes.
 *
 * Every place that used to compute `slug(d.name)` for a PHYSICAL name now calls this.
 */
export function physicalSlug(d: { slug?: string; name: string }): string {
  return d.slug ?? slug(d.name);
}

/**
 * The longest table name the OS mints in a personal lane: 63 characters, the identifier limit
 * of PostgreSQL — the tightest one in the stack (Polaris persists on PostgreSQL; Trino and
 * Iceberg have no shorter limit). Keeping lane names inside it means a name is never truncated
 * by any component it passes through.
 */
export const LANE_TABLE_MAX = 63;

/**
 * The personal-lane NAME of a NEW dataset: `<slug(name)>_<dataset id without "ds_">`.
 *
 * WHY THE ID, NOT THE DOMAIN. A lane is one schema per OWNER (`personal_<owner>`) shared by every
 * dataset that owner builds, in every domain. Naming its tables after the dataset name alone
 * (`gold_<slug>`) let two datasets with the same name write the SAME table — seen live: a
 * personal draft rebuilt the table a domain asset of the same name read. Adding the domain would
 * still collide for two same-named datasets in one domain (or after a domain move); the dataset id
 * is unique by construction and never changes, so it is the only suffix that rules a collision
 * out. The readable name stays in front, so `gold_northpeak_goods_receipts_r0ejqrd65h` is still
 * recognisable in Trino. The name part is shortened so `bronze_<lane>` fits {@link LANE_TABLE_MAX}.
 *
 * Recorded ONCE at create (`Dataset.laneSlug`) and never recomputed — a rename does not move it.
 */
export function newLaneSlug(name: string, id: string): string {
  const tail = sanitizeIdent(id.replace(/^ds_/, ''));
  const room = LANE_TABLE_MAX - 'bronze_'.length - 1 - tail.length;
  const base = slug(name).slice(0, Math.max(1, room)).replace(/_+$/, '') || 'dataset';
  return `${base}_${tail}`;
}

/**
 * The slug a dataset's PERSONAL-LANE tables are named with: the recorded `laneSlug` when the
 * dataset has one (every dataset created since lane names became unique, and every older one the
 * record-lane-names migration has stamped), else the legacy `physicalSlug` — so the tables an
 * existing dataset already wrote are read where they are, and nothing is silently renamed.
 */
export function laneSlug(d: { laneSlug?: string; slug?: string; name: string }): string {
  return d.laneSlug ?? physicalSlug(d);
}

/** The personal-lane TABLE name of one layer (`<layer>_<laneSlug>`), schema not included. */
export function laneTable(d: { laneSlug?: string; slug?: string; name: string }, layer: Layer): string {
  return `${layer}_${laneSlug(d)}`;
}

/** The full personal-lane FQN of one layer: `iceberg.personal_<owner>.<layer>_<laneSlug>`. */
export function laneFqn(d: { owner: string; laneSlug?: string; slug?: string; name: string }, layer: Layer): string {
  return `iceberg.${personalSchema(d.owner)}.${laneTable(d, layer)}`;
}

/**
 * Is this dataset's lane name provably its OWN? True only for a lane name minted by
 * {@link newLaneSlug} (it ends in the dataset's own id). A legacy name (absent, or recorded by
 * the migration as the old name-only slug) may be shared with a same-named dataset, so it is
 * never served as this dataset's data.
 */
export function laneIsUnique(d: { id: string; laneSlug?: string }): boolean {
  return !!d.laneSlug && d.laneSlug.endsWith(`_${sanitizeIdent(d.id.replace(/^ds_/, ''))}`);
}

/** A governed (asset/product) dataset is served ONLY from its domain copy. */
export function isGoverned(d: { tier: string }): boolean {
  return d.tier !== 'dataset';
}

/**
 * The typed refusal for a governed dataset whose DOMAIN copy does not exist: the registry says it
 * is served, but there is no table in its domain schema. It is never answered from the owner's
 * lane instead — that lane is the owner's workspace and may hold something else entirely.
 */
export class NotBuiltError extends Error {
  readonly code = 'not_built';
  readonly status = 409;
  readonly datasetId: string;
  readonly datasetName: string;
  readonly fqn: string;
  constructor(datasetId: string, datasetName: string, fqn: string) {
    super(`“${datasetName}” (${datasetId}) has no domain copy: ${fqn} does not exist. Re-promote the dataset to write it.`);
    this.name = 'NotBuiltError';
    this.datasetId = datasetId;
    this.datasetName = datasetName;
    this.fqn = fqn;
  }
}

/** True when a Trino failure means the named table (or its schema) does not exist. */
export function isMissingTableError(e: unknown): boolean {
  const m = (e as Error)?.message ?? '';
  return /\b(TABLE_NOT_FOUND|SCHEMA_NOT_FOUND)\b/.test(m) || /\b(Table|Schema) '[^']+' does not exist\b/.test(m);
}

/**
 * Sanitize a principal/uid to a stable identifier — the SAME normalization the
 * data-runner (`slug`) and the query-tool write guard (`personal_schema`) apply, so
 * the object-storage prefix, the Iceberg namespace and the OPA subject stay in
 * lockstep. A uid that isn't a bare identifier (e.g. an email) maps deterministically.
 */
export function sanitizeIdent(value: string): string {
  const core = (value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return core || 'user';
}

/** The caller's PRIVATE Iceberg namespace (M1 personal lane: `iceberg.personal_<uid>.*`).
 *  Bronze uploads land here — un-promoted work lives in the personal lane until a
 *  governed promotion (dbt-trino CTAS) materializes it into the domain schema. */
export function personalSchema(principal: string): string {
  return `personal_${sanitizeIdent(principal)}`;
}

/**
 * The Trino/Iceberg SCHEMA a domain's governed marts live in. A domain id can carry
 * characters that are NOT legal in an unquoted SQL identifier — notably a HYPHEN
 * (e.g. `agentic-leader-q3-2026`), which makes `iceberg.<domain>.<t>` a Trino
 * SYNTAX_ERROR and leaves the catalog reading a schema that can never be created.
 * Normalize the domain to the SAME identifier shape as the personal lane so the
 * schema is always valid and WRITES + READS agree on one name.
 */
export function domainSchema(domain: string): string {
  return sanitizeIdent(domain);
}

/**
 * The Trino principal a governed READ must run AS. A `personal_<uid>` schema is owned
 * by that user ALONE (Trino OPA `is_owned_personal`), so a read that touches the
 * caller's OWN personal lane MUST run as the owner (`user.id`) — even the owner is
 * DENIED reading their own personal table under the domain principal. Every other read
 * (a governed asset/product, or a bare/unqualified query) runs as the caller's domain
 * principal, so cross-domain governance stays intact. This mirrors the owner-principal
 * logic in `builtLayerFqn` that the preview/profile routes already use.
 *
 * Derived SERVER-SIDE from the signed session + the SQL text — NEVER trusted from the
 * request body. Only the caller's OWN personal schema flips the principal to their id;
 * another user's `personal_*` schema is left on the domain principal (Trino/OPA denies
 * it regardless — we never impersonate to reach someone else's private lane).
 */
export function readPrincipalFor(sql: string, user: { id: string; domains: string[] }): string {
  const own = personalSchema(user.id); // personal_<sanitizeIdent(uid)> — regex-safe ([a-z0-9_])
  // Match the schema only as a qualified-name segment: `…personal_<uid>.<table>`.
  const touchesOwnLane = new RegExp(`(^|[^a-z0-9_])${own}\\.`, 'i').test(sql);
  return touchesOwnLane ? user.id : (user.domains[0] ?? user.id);
}

/** The Bronze table FQN for a dataset landing in a given schema. `nameOrSlug` is the
 *  dataset's PHYSICAL slug: at ingest (creation) the raw name is passed (no frozen slug
 *  exists yet, so `slug(name)` is the physical identity); a caller with a dataset in hand
 *  should pass `physicalSlug(d)` so a renamed dataset keeps its frozen bronze table. */
export function bronzeTarget(schema: string, nameOrSlug: string): string {
  return `iceberg.${schema}.bronze_${slug(nameOrSlug)}`;
}

/** The governed Iceberg target a promotion writes via dbt-trino (gold preferred). */
export function assetTarget(d: Dataset): string {
  const layer = d.versions.gold.built ? 'gold' : 'silver';
  return `iceberg.${domainSchema(d.domain)}.${layer}_${physicalSlug(d)}`;
}

/**
 * The physical FQN of a dataset being REUSED as a curated compose / gold-join SOURCE.
 * Identical to {@link assetTarget} for a governed asset/product (the domain copy), but a
 * PERSONAL (My-tier) dataset physically lives ONLY in its owner's personal lane — never
 * the domain schema — so it MUST resolve there or the join hits TABLE_NOT_FOUND. Personal
 * sources are owner-only (`canView`), so the caller composing the dataset IS `d.owner`,
 * and the personal-lane read runs AS that uid (the gold-join route flips the Trino
 * principal to the owner whenever the target schema is `personal_*`, which a personal
 * curated dataset always is). Asset/product resolution is byte-identical to before.
 */
export function reuseSourceFqn(d: Dataset): string {
  // CONNECTED datasets first — the SAME branches as {@link versionTarget}, so a compose
  // reads exactly the table every other consumer reads. A LIVE dataset IS the external
  // `catalog.schema.table` (no personal lane, no domain copy); a SYNC dataset is its landed
  // governed copy. Falling through to `assetTarget` here minted a PHANTOM
  // `iceberg.<domain>.<layer>_<slug>` for a live dataset — a table (and, before any publish,
  // a schema) that never existed, surfacing as Trino `SCHEMA_NOT_FOUND` on Save Composition.
  if (d.connected && d.connected.mode === 'live') {
    const s = d.connected.source;
    return `${s.catalog}.${s.schema}.${s.table}`;
  }
  if (d.connected && d.connected.mode === 'sync') {
    return `iceberg.${domainSchema(d.domain)}.${d.connected.tier}_${physicalSlug(d)}`;
  }
  const layer: Layer = d.versions.gold.built ? 'gold' : 'silver';
  if (d.tier === 'dataset') {
    return laneFqn(d, layer);
  }
  return assetTarget(d);
}

/**
 * Why a dataset CANNOT be a curated compose / gold-join source today — or `null` when it
 * can. The Gold compiler writes ONE Iceberg CTAS and (by design, tested) refuses a
 * cross-catalog read, so a LIVE connected dataset — a federated external table with no
 * governed Iceberg copy — has nothing it may read. The picker (`listJoinable`) and the
 * gold-join route share this ONE rule so the UI never offers, and the server never
 * compiles, a source that can only fail: the user gets the reason + the remedy (adopt the
 * table in SYNC mode, which lands a governed copy) instead of a raw Trino error.
 */
export function composeSourceBlocker(d: Pick<Dataset, 'name' | 'connected'>): string | null {
  if (d.connected && d.connected.mode === 'live') {
    return `“${d.name}” is a live connected table (read straight from its source) and cannot be composed into a curated dataset yet — adopt it in sync mode to land a governed copy first.`;
  }
  return null;
}

/** The product FQN a certified asset is listed/queried under. */
export function productTarget(d: Dataset): string {
  const layer = d.versions.gold.built ? 'gold' : 'silver';
  return `iceberg.${domainSchema(d.domain)}.${layer}_${physicalSlug(d)}`;
}

/**
 * The physical Iceberg FQN of ONE specific medallion version, resolved VIEWER-AWARE —
 * mirroring {@link readPrincipalFor} so the FQN's SCHEMA and the Trino session principal
 * always agree (Trino runs the query AS the identity that OWNS the schema).
 *
 * Physical lane model (data-architecture-model.md): the OWNER's personal lane
 * (`personal_<owner>`) physically holds EVERY layer they built — bronze and any
 * un-promoted silver/gold. A governed PROMOTION (dbt-trino CTAS) copies only the promoted
 * gold/silver into the domain schema; bronze is NEVER shared. So:
 *   - the OWNER viewing their own dataset reads ALL layers from their personal lane
 *     (`personal_<owner>.<layer>_<slug>`) — this is why an un-promoted bronze/silver/gold
 *     read must NOT target the domain schema (that table doesn't exist there → TABLE_NOT_FOUND);
 *   - a NON-OWNER viewing a Shared/Certified dataset reads the promoted copy from the
 *     domain schema (`domainSchema(d.domain).<layer>_<slug>`). A non-owner's bronze read
 *     resolves to the domain schema and simply won't find a table there — correct,
 *     fail-closed: bronze is never shared, and we NEVER build a `personal_<owner>` FQN for
 *     someone who isn't the owner (OPA would deny it anyway; we don't even construct it).
 */
export function versionTarget(d: Dataset, layer: Layer, viewer: { id: string }): string {
  // CONNECTED · LIVE branch FIRST (lakehouse-import-exposure.md, Phase 2): an adopted
  // live dataset IS the external table — its FQN is the verbatim `catalog.schema.table`
  // the exposure opened, for EVERYONE (there is no personal lane, no domain copy, no
  // medallion materialization). Governance rides on the exposure's OPA entry keyed on this
  // exact FQN; the read runs as the viewer's DOMAIN principal (see readPrincipalFor /
  // builtLayerFqn — never the personal lane). Sync mode is Phase 3 (falls through to the
  // domain/personal resolution below until it lands its own copy).
  if (d.connected && d.connected.mode === 'live') {
    const s = d.connected.source;
    return `${s.catalog}.${s.schema}.${s.table}`;
  }
  // CONNECTED · SYNC branch (lakehouse-import-exposure.md, Phase 3): an adopted sync
  // dataset holds a GOVERNED COPY the sync engine lands into the domain schema at the
  // declared tier — `iceberg.<domainSchema>.<tier>_<slug>` for EVERYONE (owner included:
  // there is no personal lane, the landing writes straight to the domain schema). Preview/
  // profile/DQ/Talk/metrics then work on this local copy with no special-casing. The read
  // runs AS the viewer's domain principal (see builtLayerFqn), matching this schema.
  if (d.connected && d.connected.mode === 'sync') {
    return `iceberg.${domainSchema(d.domain)}.${d.connected.tier}_${physicalSlug(d)}`;
  }
  // A GOVERNED dataset (asset/product) is its DOMAIN copy for every viewer — the owner
  // included. The owner's lane is their build workspace: it may hold an unpublished rebuild, or
  // (before lane names were unique) another dataset's table of the same name. A PERSONAL dataset
  // lives only in its owner's lane; a non-owner resolves to the domain schema, where it does not
  // exist — fail-closed, never `personal_<otherUser>` (see readPrincipalFor).
  if (isGoverned(d) || viewer.id !== d.owner) return `iceberg.${domainSchema(d.domain)}.${layer}_${physicalSlug(d)}`;
  return laneFqn(d, layer);
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
  user: { id: string; domains: string[] },
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
  if (isGoverned(d)) {
    // A governed dataset serves ONE layer, the one its promotion published to the domain schema
    // (Gold when built, else Silver — {@link assetTarget}). Every viewer, the owner included,
    // reads that copy as their domain principal; bronze is never published.
    const served: Layer | null = d.versions.gold.built ? 'gold' : d.versions.silver.built ? 'silver' : null;
    if (!layer || layer === served) {
      return served ? { layer: served, fqn: versionTarget(d, served, { id: user.id }), principal: user.domains[0] ?? user.id } : null;
    }
    // An EXPLICIT request for another layer (e.g. the owner previewing their asset's Bronze) is
    // never answered with a different layer. Only the OWNER may read it, from their lane, and
    // only when the lane name is provably this dataset's own; otherwise there is nothing to read
    // (null → the caller's not_built), never the served layer in its place.
    if (user.id === d.owner && laneIsUnique(d) && d.versions[layer]?.built) {
      return { layer, fqn: laneFqn(d, layer), principal: user.id };
    }
    return null;
  }
  const chosen = layer && d.versions[layer]?.built ? layer : (['gold', 'silver', 'bronze'] as Layer[]).find((l) => d.versions[l].built);
  if (!chosen) return null;
  // A PERSONAL dataset: only the OWNER resolves to the lane and is read AS the owner; anyone
  // else resolves to the domain schema (fail-closed) as their domain principal.
  const isOwner = user.id === d.owner;
  const fqn = versionTarget(d, chosen, { id: user.id });
  const principal = isOwner ? user.id : (user.domains[0] ?? user.id);
  return { layer: chosen, fqn, principal };
}
