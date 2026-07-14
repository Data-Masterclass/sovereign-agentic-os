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
};
