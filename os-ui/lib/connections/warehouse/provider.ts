/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * External-warehouse connector — the PER-PROVIDER interface (Phase 1b skeleton).
 *
 * `trinoCatalogProps(source)` used to be one giant `switch` over every platform in
 * a single file, which meant every platform team had to edit the same function. The
 * skeleton refactor splits that switch into a REGISTRY of `WarehouseProvider`
 * objects — ONE object per file under `providers/` — so provider teams work on
 * disjoint files. This module defines the shared shape they all implement; it is
 * frozen once the provider files land.
 *
 * A `WarehouseProvider` is pure declarative metadata + one pure function
 * (`catalogProps`): no I/O, no secrets. It answers, for a platform:
 *   - how to render the Trino catalog `.properties` (`catalogProps`),
 *   - which Trino connector / image backs it (`trinoConnector`, `nativeInImage`),
 *   - what capabilities it exposes (`capabilities`),
 *   - what CREDENTIAL fields the editor collects (`credentialFields`),
 *   - what SECRET material the deploy layer must mount (`secretMaterial`),
 *   - how a "test connection" probe works (`testProbe`),
 *   - how it maps into OpenMetadata ingestion (`openMetadata`), and
 *   - honestly, what still needs LIVE customer creds to verify
 *     (`liveVerificationRequired`).
 */

import type {
  WarehouseSource,
  TrinoCatalogProps,
  WarehousePlatform,
} from './types.ts';

/** One credential input the connection editor collects for a platform. */
export type CredentialField = {
  key: string;
  label: string;
  kind: 'text' | 'password' | 'file-json' | 'pem';
  required: boolean;
  help?: string;
};

/**
 * How a "test connection" is probed. `sql` renders a cheap round-trip query from a
 * source; `none` is honest when no safe pure probe exists (e.g. a live path that
 * only a provider agent can validate against real creds).
 */
export type TestProbe =
  | { kind: 'sql'; query: (source: WarehouseSource) => string }
  | { kind: 'none'; reason: string };

/**
 * The secret plumbing a source needs at deploy time: which vault secret keys back
 * it and which env vars the Trino catalog props reference (`${ENV:...}`). Empty
 * arrays are valid and MEANINGFUL — e.g. Glue authenticates via IRSA and needs
 * NO secret material at all.
 */
export type SecretMaterial = {
  secretKeys: string[];
  envVars: string[];
};

/**
 * How an engine addresses and folds identifiers. Engines disagree on this in ways
 * that silently break discovery + FQN building if ignored:
 *   - `quote`      — the character a provider wraps an identifier in when it must be
 *                    passed to the ENGINE verbatim (Snowflake `"`, BigQuery/Databricks
 *                    backtick). Trino itself always double-quotes; this is the engine's
 *                    OWN quote, surfaced so discovery/OM/agents can reason about casing.
 *   - `unquotedCase` — what the engine does to an UNQUOTED identifier: Snowflake
 *                    upper-cases it, BigQuery/Databricks/Glue preserve/lower-case it.
 *                    Discovery has to match case-insensitively when this is not
 *                    `preserve`, or a lower-case schema name will never match.
 */
export type IdentifierRules = {
  quote: string;
  unquotedCase: 'upper' | 'lower' | 'preserve';
};

/**
 * How a provider ENUMERATES objects. Not every engine answers `SHOW SCHEMAS` the
 * same cheap way, and one (Fabric/OneLake) has no metastore at all:
 *   - `show`  — plain `SHOW SCHEMAS/TABLES FROM …` (Glue/Iceberg, Delta w/ metastore).
 *   - `terse` — the engine has a cheaper terse listing the provider prefers to push
 *               down (Snowflake `SHOW TERSE … IN <db>`); Trino federation still uses
 *               `SHOW SCHEMAS`, but the provider records + can render the native form.
 *   - `none`  — no metastore; discovery honestly degrades (Fabric known-locations).
 */
export type DiscoveryMode = 'show' | 'terse' | 'none';

/**
 * How an engine-specific column type is carried into the OS Iceberg lakehouse on
 * IMPORT (CTAS). Some source types have no faithful Iceberg equivalent and must be
 * cast HONESTLY rather than silently mangled:
 *   - `match`   — a regexp matched against a discovered/declared source type name.
 *   - `castTo`  — the Trino type to CAST the column to in the CTAS select list, or
 *                 `undefined` to pass the column through unchanged.
 *   - `note`    — the honest caveat (why the cast, what is lost) surfaced to callers.
 */
export type TypeRule = {
  match: RegExp;
  castTo?: string;
  note: string;
};

/** The parts an engine-specific CTAS select list needs to honour source types. */
export type ImportColumn = { name: string; type: string };

/**
 * The complete per-platform contract. One object per platform, one file per object,
 * all registered in `registry.ts`. `catalogProps` is PURE and throws
 * `WarehouseError` on bad input (mirrors the old switch's behavior exactly).
 */
export type WarehouseProvider = {
  platform: WarehousePlatform;
  label: string;
  /** iceberg | hive | delta-lake | snowflake | bigquery (all native in trinodb/trino:476). */
  trinoConnector: string;
  nativeInImage: boolean;
  capabilities: { federate: boolean; import: boolean };
  /** Pure: same input → same output; throws `WarehouseError` on bad input. */
  catalogProps(source: WarehouseSource): TrinoCatalogProps;
  /**
   * Render the cheap, read-only `SHOW TABLES FROM <catalog>.<schema>` discovery
   * query for a source + schema — the SAME discipline as `testProbe.kind==='sql'`:
   * pure, no I/O, no secrets, and it VALIDATES the schema identifier so it can
   * never fold unquoted user input into SQL. A provider whose metastore exposes no
   * table listing (Fabric/OneLake — see its `testProbe.kind==='none'`) OMITS this
   * method entirely; the store then honestly reports "not discoverable".
   */
  discoverTables?(source: WarehouseSource, schema: string): string;
  credentialFields: CredentialField[];
  secretMaterial: SecretMaterial;
  testProbe: TestProbe;
  openMetadata: { connectorType: string; configKeys: string[] };
  /** Honest: what needs live customer creds to verify (empty = fully verifiable). */
  liveVerificationRequired: string[];

  // ---- Engine-specific hooks (all optional + additive; defaults are back-compatible) ----

  /**
   * How this engine addresses + folds identifiers (Snowflake upper-cases unquoted,
   * BigQuery/Databricks quote with backticks, …). Absent = the generic Trino default
   * (double-quote, case preserved). Discovery + FQN matching consult this.
   */
  identifierRules?: IdentifierRules;

  /**
   * How this engine enumerates objects. Absent ⇒ inferred: `show` when
   * `discoverTables` is present, `none` when it is not.
   */
  discoveryMode?: DiscoveryMode;

  /**
   * The engine's NATIVE (often cheaper/terse) schema-listing form, for the provider's
   * own discovery/diagnostics — distinct from the Trino-federated `SHOW SCHEMAS FROM
   * <catalog>` the store runs. Pure; validates its inputs. Absent = no native form
   * beyond the federated one.
   */
  nativeSchemaListing?(source: WarehouseSource): string;

  /**
   * Engine-specific semi-structured / complex column handling for IMPORT. Ordered
   * rules matched against a source column's declared type; the FIRST match wins. Used
   * by `import.ts` to build an honest CTAS select list (e.g. Snowflake VARIANT →
   * `CAST(col AS json)`), and surfaced so callers can warn about lossy casts. Absent =
   * plain `SELECT *` (every column passed through unchanged).
   */
  importTypeRules?: TypeRule[];

  /**
   * Freeform, honest engine guardrails NOT already covered by
   * `liveVerificationRequired` — casing gotchas, cost model, pushdown, experimental
   * status. Surfaced in the editor / registration snippet. Absent = none.
   */
  notes?: string[];
};
