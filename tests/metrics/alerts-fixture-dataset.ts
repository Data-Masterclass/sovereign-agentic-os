/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * The governed dataset the alerts eject builds its dbt project from (data tab generator), kept
 * outside os-ui/tabs so the metrics tab never imports the data tab (GLUE-9).
 */
import type { Dataset } from '../../os-ui/tabs/data/lib/index.ts';

const built = (artifact: string, passThrough = false) => ({ built: true, passThrough, quality: 'unknown' as const, updatedAt: '2026-11-13T00:00:00.000Z', artifact });
export const ORDERS = {
  version: '1', id: 'ds_orders1', name: 'Orders', owner: 'amir', domain: 'sales', tier: 'asset', visibility: 'domain', folder: '/',
  description: 'Web-shop orders.', grants: [], viewNamespaced: true,
  columns: [{ name: 'order_id' }, { name: 'order_date' }, { name: 'region' }, { name: 'net_amount' }],
  versions: { bronze: built('bronze/orders.dlt.yml'), silver: built('silver/stg_orders.sql', true), gold: built('gold/mart_orders.sql', true) },
  measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount', label: 'Revenue' }, { name: 'orders', type: 'count', sql: '' }],
} as unknown as Dataset;

