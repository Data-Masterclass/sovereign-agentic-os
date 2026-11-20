/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        metrics
 * FEATURE:    WP-50 (alerts) test fixture — one governed dataset with two measures
 * USER STORY: As a test author I want the alert writer, its unit tests and the MetricFlow eject to
 *             share one dataset, so the eject runs the exact project the unit tests describe.
 * ARCHITECTURE: Plain data; imported by tests only.
 */
import type { Dataset } from '@tabs/data/lib/index';

const built = (artifact: string, passThrough = false) => ({ built: true, passThrough, quality: 'unknown' as const, updatedAt: '2026-11-13T00:00:00.000Z', artifact });
export const ORDERS = {
  version: '1', id: 'ds_orders1', name: 'Orders', owner: 'amir', domain: 'sales', tier: 'asset', visibility: 'domain', folder: '/',
  description: 'Web-shop orders.', grants: [], viewNamespaced: true,
  columns: [{ name: 'order_id' }, { name: 'order_date' }, { name: 'region' }, { name: 'net_amount' }],
  versions: { bronze: built('bronze/orders.dlt.yml'), silver: built('silver/stg_orders.sql', true), gold: built('gold/mart_orders.sql', true) },
  measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount', label: 'Revenue' }, { name: 'orders', type: 'count', sql: '' }],
} as unknown as Dataset;

