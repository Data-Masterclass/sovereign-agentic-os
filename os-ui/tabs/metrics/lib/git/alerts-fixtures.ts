/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        metrics
 * FEATURE:    WP-50 (alerts) test fixture — a domain repo's committed dbt semantic YAML
 * USER STORY: As a test author I want the alert writer tested against the exact `metrics:` file the
 *             data tab's generator commits for a dataset with two measures (revenue, orders).
 * ARCHITECTURE: Plain data, copied from the generator's output (tests/metrics/alerts-eject.docker.test.ts
 *   builds the same project with the real generator and runs dbt + MetricFlow on it).
 */
export const VIEW = 'sales__Orders';

export const SEMANTIC_YAML = `semantic_models:
  - name: sales_orders
    model: ref('gold_orders')
    entities:
      - name: orders
        type: primary
        expr: order_id
    measures:
      - name: revenue
        agg: sum
        expr: net_amount
      - name: sales_orders_orders
        agg: count
        expr: "1"
metrics:
  - name: orders
    type: simple
    type_params:
      measure: sales_orders_orders
    config:
      meta:
        os_member: sales__Orders.orders
  - name: revenue
    type: simple
    type_params:
      measure: revenue
    config:
      meta:
        os_member: sales__Orders.revenue
`;

/** The committed dbt property files of the fixture domain. */
export function committedDbt(): Map<string, string> {
  return new Map([['models/semantic/sales_orders.yml', SEMANTIC_YAML]]);
}
