/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * External-warehouse connector — the FEDERATED DATASET shape + pure mapper (Phase 1).
 *
 * A federated dataset is the minimal registry representation of ONE external table
 * as a governed, READ-ONLY dataset. It is deliberately distinct from a materialized
 * sovereign `Dataset` (lib/data/dataset-schema.ts): a sovereign dataset lives in the
 * OS Iceberg lakehouse (physical, medallion-versioned); a federated dataset is just
 * a pointer at `catalog.schema.table` in an external source, queried live through
 * the SAME governed Trino path. Importing a federated dataset (CTAS) is what turns
 * it into a sovereign product — that's the existing promote/materialize path.
 *
 * This module is PURE: the type + a total mapper from an OM/Glue table descriptor
 * to a `FederatedDataset`. It does NOT perform live OM ingestion (Phase 1b) — it
 * defines the INTERFACE (`TableDescriptor`) + the transform.
 */

import type { WarehousePlatform } from './types.ts';
import { externalTableFqn } from './catalog-props.ts';

/** One column as reflected from the external catalog (OM/Glue). */
export type FederatedColumn = {
  name: string;
  /** The source-reported type, kept verbatim (e.g. `varchar`, `bigint`). */
  dataType: string;
  description?: string;
};

/**
 * The minimal registry entry for an external table exposed as a governed,
 * read-only dataset. `kind: 'federated'` is the discriminator that keeps it apart
 * from a materialized sovereign `Dataset`.
 */
export type FederatedDataset = {
  kind: 'federated';
  /** Stable id: `federated:<catalog>.<schema>.<table>`. */
  id: string;
  /** The external Trino FQN the OS queries: `<catalog>.<schema>.<table>`. */
  fqn: string;
  /** Human-facing name (defaults to the table name). */
  name: string;
  /** The Trino catalog this table is mounted under (the external source). */
  catalog: string;
  schema: string;
  table: string;
  /** Which external platform backs the source (provenance for the UI). */
  platform: WarehousePlatform;
  /** The owning OS domain — governance/RLS is applied at OUR OPA on this domain. */
  domain: string;
  description: string;
  columns: FederatedColumn[];
  /** Always read-only: federation never writes back to the external source. */
  readOnly: true;
};

/**
 * The descriptor shape a live OM/Glue table pull yields (Phase 1b wires the pull;
 * this is the pure INPUT contract). Deliberately loose on columns so both OM's and
 * Glue's shapes can be normalized upstream before calling the mapper.
 */
export type TableDescriptor = {
  schema: string;
  table: string;
  description?: string;
  columns?: FederatedColumn[];
};

/**
 * Map an external table descriptor → a governed, read-only `FederatedDataset`.
 * Pure + total: throws (via `externalTableFqn`) on a malformed catalog/schema/table
 * rather than emitting a nonsense entry.
 */
export function toFederatedDataset(input: {
  catalog: string;
  platform: WarehousePlatform;
  domain: string;
  descriptor: TableDescriptor;
}): FederatedDataset {
  const { catalog, platform, domain, descriptor } = input;
  const fqn = externalTableFqn(catalog, descriptor.schema, descriptor.table);
  return {
    kind: 'federated',
    id: `federated:${fqn}`,
    fqn,
    name: descriptor.table,
    catalog,
    schema: descriptor.schema,
    table: descriptor.table,
    platform,
    domain,
    description: descriptor.description ?? '',
    columns: descriptor.columns ?? [],
    readOnly: true,
  };
}
