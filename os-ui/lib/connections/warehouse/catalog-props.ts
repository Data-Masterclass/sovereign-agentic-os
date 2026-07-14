/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * External-warehouse connector — the PURE Trino catalog-props generator (Phase 1).
 *
 * Given a typed {@link WarehouseSource}, `trinoCatalogProps` returns the Trino
 * catalog `.properties` map that mounts the external source as ONE governed Trino
 * catalog. The deploy layer (Phase 1b) turns this map into a file at
 * `/etc/trino/catalog/<catalog>.properties`; this module is pure + fully tested.
 *
 * `trinoCatalogProps` is a thin dispatcher: it validates the shared catalog-name
 * rule then delegates to the platform's provider (`providers/<platform>.ts`, wired
 * via `registry.ts`). GLUE is implemented end-to-end; the other platforms are
 * well-formed provider stubs whose `catalogProps` throws `WarehouseError` with a
 * clear "not yet implemented in Phase 1" (501) message so the shape is established
 * without pretending to be a validated live path.
 *
 * KEY RULE: no static credentials are ever emitted. Glue authenticates via the
 * pod's IAM role (IRSA) — the AWS SDK default credential chain — so there are NO
 * `aws-access-key` / `aws-secret-key` lines in the generated props.
 */

import {
  type WarehouseSource,
  type TrinoCatalogProps,
  isValidCatalogName,
  WarehouseError,
} from './types.ts';
import { providerFor } from './registry.ts';

/**
 * Render the Trino catalog `.properties` for an external warehouse source.
 * Pure: same input → same output; no I/O, no secrets.
 *
 * Thin dispatcher: validates the catalog name (shared across all platforms) then
 * delegates to the platform's provider. The per-platform rendering lives in
 * `providers/<platform>.ts` and is wired through `registry.ts`, so provider teams
 * edit disjoint files instead of one shared switch.
 */
export function trinoCatalogProps(source: WarehouseSource): TrinoCatalogProps {
  if (!isValidCatalogName(source.catalog)) {
    throw new WarehouseError(
      `invalid Trino catalog name '${source.catalog}' (must match [a-z_][a-z0-9_]*)`,
    );
  }
  return providerFor(source.platform).catalogProps(source);
}

/**
 * Map an EXTERNAL fully-qualified table name to its OS-facing Trino FQN.
 *
 * An external source exposes tables as `<schema>.<table>` within its Glue/other
 * catalog. Once mounted as the Trino catalog `<catalog>`, the OS addresses it as
 * `<catalog>.<schema>.<table>` — the SAME three-part shape the governed query path
 * and OPA already understand. This is the discovery/query on-ramp; it does NOT
 * copy data (that's `import as product`).
 *
 * Pure + total: throws `WarehouseError` on a malformed input rather than emitting
 * a nonsense FQN.
 */
export function externalTableFqn(
  catalog: string,
  schema: string,
  table: string,
): string {
  for (const [label, part] of [
    ['catalog', catalog],
    ['schema', schema],
    ['table', table],
  ] as const) {
    if (!part || !isValidCatalogName(part)) {
      throw new WarehouseError(`external FQN: invalid ${label} segment '${part ?? ''}'`);
    }
  }
  return `${catalog}.${schema}.${table}`;
}
