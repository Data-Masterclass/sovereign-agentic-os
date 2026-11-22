/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Trino catalogs as data sources (Platform view)
 * USER STORY: As a platform admin I see every catalog Trino serves and which OS connection uses it,
 *             and I am warned when a connection points at a catalog Trino does not serve.
 * ARCHITECTURE: pure. Trino owns the catalog list (chart); the OS owns only its connections.
 */
import type { Alert } from '@tabs/monitoring/lib/types';

export type ConnectionCatalog = { catalog: string; connectionId: string; name: string; domain: string };
export type DataSourceRow = { catalog: string; origin: 'platform' | 'os-connection'; connection: ConnectionCatalog | null };

export function dataSourceRows(trinoCatalogs: readonly string[], connections: readonly ConnectionCatalog[]): { rows: DataSourceRow[]; alerts: Alert[] } {
  const byCatalog = new Map(connections.map((c) => [c.catalog, c]));
  const rows = trinoCatalogs.map((catalog): DataSourceRow => {
    const connection = byCatalog.get(catalog) ?? null;
    return { catalog, origin: connection ? 'os-connection' : 'platform', connection };
  });
  const served = new Set(trinoCatalogs);
  const alerts = connections.filter((c) => !served.has(c.catalog)).map((c): Alert => ({
    id: `al-catalog-missing-${c.connectionId}`, severity: 'warning', domain: c.domain, owner: 'platform', cluster: true, disposition: 'notified', source: 'live',
    title: `Trino does not serve the catalog of connection ${c.name}`,
    detail: `The OS connection ${c.name} (${c.connectionId}) uses the Trino catalog ${c.catalog}, but Trino does not list it in system.metadata.catalogs. Catalogs belong to Trino and its chart: register or restore it there. Queries through this connection fail until then.`,
  }));
  return { rows, alerts };
}
