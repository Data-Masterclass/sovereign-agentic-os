/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, Layer } from './dataset-schema.ts';

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
  const layer: Layer = d.versions.gold.built ? 'gold' : 'silver';
  if (d.tier === 'dataset') {
    return `iceberg.${personalSchema(d.owner)}.${layer}_${physicalSlug(d)}`;
  }
  return assetTarget(d);
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
  // FAIL-CLOSED: only the OWNER resolves to the personal lane. Everyone else resolves to
  // the domain schema — never `personal_<otherUser>` (see readPrincipalFor: the schema and
  // the read principal must be the identity that owns the schema).
  const isOwner = viewer.id === d.owner;
  const schema = isOwner ? personalSchema(d.owner) : domainSchema(d.domain);
  return `iceberg.${schema}.${layer}_${physicalSlug(d)}`;
}
