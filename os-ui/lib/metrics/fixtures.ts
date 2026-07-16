/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { emptyVersions, type Dataset } from '../data/dataset-schema.ts';

/** A built, documented Gold "Sales" dataset — the shared test fixture for the
 *  Metrics/Dashboards spine (kept out of *.test.ts so importing it never re-runs
 *  another file's tests). */
export function goldSales(over: Partial<Dataset> = {}): Dataset {
  const versions = emptyVersions();
  versions.bronze.built = true; versions.silver.built = true; versions.gold.built = true;
  return {
    version: '1', id: 'ds_sales', name: 'Sales', owner: 'amir', domain: 'sales',
    tier: 'asset', visibility: 'domain', folder: '/', description: 'Sales orders.', versions,
    grants: [], measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount' }],
    columns: [
      { name: 'order_id', description: 'Key.' },
      { name: 'order_date', description: 'When.' },
      { name: 'region', description: 'Where.' },
      { name: 'net_amount', description: 'Value.' },
    ],
    ...over,
  };
}
