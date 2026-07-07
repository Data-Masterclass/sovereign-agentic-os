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

/** The Bronze table FQN for a dataset landing in a given schema. */
export function bronzeTarget(schema: string, name: string): string {
  return `iceberg.${schema}.bronze_${slug(name)}`;
}

/** The governed Iceberg target a promotion writes via dbt-trino (gold preferred). */
export function assetTarget(d: Dataset): string {
  const layer = d.versions.gold.built ? 'gold' : 'silver';
  return `iceberg.${domainSchema(d.domain)}.${layer}_${slug(d.name)}`;
}

/** The product FQN a certified asset is listed/queried under. */
export function productTarget(d: Dataset): string {
  const layer = d.versions.gold.built ? 'gold' : 'silver';
  return `iceberg.${domainSchema(d.domain)}.${layer}_${slug(d.name)}`;
}

/**
 * The physical Iceberg FQN of ONE specific medallion version — the same
 * `iceberg.<domainSchema>.<layer>_<slug>` name the Build adapters materialise
 * (`live.ts` bronze/silver/gold targets). The Explore/profile panel resolves
 * against this so it profiles the exact table a version wrote — no new naming.
 */
export function versionTarget(d: Dataset, layer: Layer): string {
  return `iceberg.${domainSchema(d.domain)}.${layer}_${slug(d.name)}`;
}
