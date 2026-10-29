/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * External-warehouse connector — the PROVIDER REGISTRY.
 *
 * The single place the per-provider `WarehouseProvider` objects are wired together.
 * `trinoCatalogProps` (catalog-props.ts) dispatches through `providerFor(platform)`;
 * the deploy / editor layers read the rest of each provider's metadata. Adding
 * a platform means adding its file + one line here — no shared switch to fight over.
 */

import type { WarehousePlatform } from '@tabs/connections/lib/warehouse/types';
import { WarehouseError } from '@tabs/connections/lib/warehouse/types';
import type { WarehouseProvider } from '@tabs/connections/lib/warehouse/provider';
import { glueProvider } from '@tabs/connections/lib/warehouse/providers/glue';
import { snowflakeProvider } from '@tabs/connections/lib/warehouse/providers/snowflake';
import { bigqueryProvider } from '@tabs/connections/lib/warehouse/providers/bigquery';
import { databricksProvider } from '@tabs/connections/lib/warehouse/providers/databricks';
import { fabricProvider } from '@tabs/connections/lib/warehouse/providers/fabric';
import { postgresProvider } from '@tabs/connections/lib/warehouse/providers/postgres';
import { mysqlProvider } from '@tabs/connections/lib/warehouse/providers/mysql';
import { sqlServerProvider } from '@tabs/connections/lib/warehouse/providers/sqlserver';
import { mongoProvider } from '@tabs/connections/lib/warehouse/providers/mongodb';
import { kafkaProvider } from '@tabs/connections/lib/warehouse/providers/kafka';

/** Every supported warehouse platform → its provider. Not all platforms may have a
 *  provider yet (operational-database platforms are registered incrementally as their
 *  provider modules land); `providerFor` throws on an unregistered platform. */
export const WAREHOUSE_PROVIDERS: Partial<Record<WarehousePlatform, WarehouseProvider>> = {
  glue: glueProvider,
  snowflake: snowflakeProvider,
  bigquery: bigqueryProvider,
  'databricks-delta': databricksProvider,
  fabric: fabricProvider,
  postgresql: postgresProvider,
  mysql: mysqlProvider,
  sqlserver: sqlServerProvider,
  mongodb: mongoProvider,
  kafka: kafkaProvider,
};

/** Resolve the provider for a platform. Throws `WarehouseError` on an unknown one. */
export function providerFor(platform: WarehousePlatform): WarehouseProvider {
  const provider = WAREHOUSE_PROVIDERS[platform];
  if (provider == null) {
    throw new WarehouseError(`unknown warehouse platform: ${String(platform)}`);
  }
  return provider as WarehouseProvider;
}
