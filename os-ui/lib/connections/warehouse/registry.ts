/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * External-warehouse connector — the PROVIDER REGISTRY.
 *
 * The single place the per-provider `WarehouseProvider` objects are wired together.
 * `trinoCatalogProps` (catalog-props.ts) dispatches through `providerFor(platform)`;
 * the deploy / editor / OM layers read the rest of each provider's metadata. Adding
 * a platform means adding its file + one line here — no shared switch to fight over.
 */

import type { WarehousePlatform } from './types.ts';
import { WarehouseError } from './types.ts';
import type { WarehouseProvider } from './provider.ts';
import { glueProvider } from './providers/glue.ts';
import { snowflakeProvider } from './providers/snowflake.ts';
import { bigqueryProvider } from './providers/bigquery.ts';
import { databricksProvider } from './providers/databricks.ts';
import { fabricProvider } from './providers/fabric.ts';

/** Every supported warehouse platform → its provider. Total over WarehousePlatform. */
export const WAREHOUSE_PROVIDERS: Record<WarehousePlatform, WarehouseProvider> = {
  glue: glueProvider,
  snowflake: snowflakeProvider,
  bigquery: bigqueryProvider,
  'databricks-delta': databricksProvider,
  fabric: fabricProvider,
};

/** Resolve the provider for a platform. Throws `WarehouseError` on an unknown one. */
export function providerFor(platform: WarehousePlatform): WarehouseProvider {
  const provider = WAREHOUSE_PROVIDERS[platform];
  if (!provider) {
    throw new WarehouseError(`unknown warehouse platform: ${String(platform)}`);
  }
  return provider;
}
