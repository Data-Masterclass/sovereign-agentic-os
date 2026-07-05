/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Data Masterclass
 *
 * The Northpeak cohort DATA seed — one coherent e-commerce case study derived from
 * the ONE physical mart that already exists on the tenant:
 *
 *   iceberg.sales.gold_northpeak_commerce   (150,000 session-grain rows:
 *   order_id, customer_id, region, product, net_amount, order_total, converted,
 *   order_date, is_churned — see charts/.../lakehouse/northpeak-marts-init.yaml)
 *
 * This module is PURE DATA + SQL strings (no I/O): six governed datasets across
 * bronze/silver/gold in the teaching domain `northpeak`, their column docs, Cube
 * measures, lineage edges and three dashboards. `marts.mjs` materializes the SQL
 * through the governed query-tool `/execute`; `seed.mjs` drives the os-ui governed
 * API with the rest. Kept import-free so `node --test marts.test.mjs` can verify
 * every statement against a mirror of the /execute guard OFFLINE.
 *
 * SQL discipline (must pass images/query-tool/execute_guard.py verbatim):
 *   - exactly ONE statement, no trailing ';', no SQL comments anywhere;
 *   - only `create schema if not exists iceberg.<schema>` and
 *     `create or replace table iceberg.<schema>.<table> as select …`;
 *   - bare lowercase identifiers; target schema is ALWAYS `northpeak` (the seed
 *     identity's own domain — builder role floor).
 * Synthetic values are DETERMINISTIC (mod-prime patterns, the marts-init
 * convention) so re-runs are byte-stable and the seed stays idempotent.
 */

export const STORE = {
  name: 'Northpeak',
  tagline: 'outdoor & apparel e-commerce — the cohort teaching case study',
};

/** The teaching domain: a valid Trino schema ident (the cohort domain
 *  `agentic-leader-q3-2026` contains hyphens and can never be a physical schema). */
export const DOMAIN = 'northpeak';

/** The cohort domain the 36 students live in (grants target — never a schema). */
export const COHORT_DOMAIN = 'agentic-leader-q3-2026';

/** Authoring cast (must exist in OS_USERS with `northpeak` appended to domains). */
export const INSTRUCTOR = { id: 'alp-instructor', role: 'builder' };
export const ADMIN = { id: 'aborek', role: 'admin' };

/** The pre-existing physical base mart the whole star derives from. */
export const BASE_MART = 'iceberg.sales.gold_northpeak_commerce';

const T = (layer, slug) => `iceberg.${DOMAIN}.${layer}_${slug}`;

/** Grants applied at promote + kept at certify — the ONE policy source the compiler
 *  turns into Trino-OPA + Cube access. The `user:agentic-leader-q3-2026` grant is a
 *  deliberate seam workaround: /api/query + NL→SQL read as the DOMAIN principal
 *  (`u.domains[0]`), which the pushed OPA roster does not declare — putting the
 *  literal principal string into `shared_with_users` keeps student Query-tab reads
 *  working (trino.rego `table_entitled` honours it). Platform fix tracked for W5/T8. */
export const GRANTS = [
  { grantee: { kind: 'domain', id: DOMAIN }, scope: { rows: [], columns: { mask: [], hide: [] } }, cardinality: 'low', action: 'read' },
  { grantee: { kind: 'domain', id: COHORT_DOMAIN }, scope: { rows: [], columns: { mask: [], hide: [] } }, cardinality: 'low', action: 'read' },
  { grantee: { kind: 'user', id: COHORT_DOMAIN }, scope: { rows: [], columns: { mask: [], hide: [] } }, cardinality: 'low', action: 'read' },
];

// ------------------------------------------------------------------ datasets ----
// Each entry: registry name (slug must match store-fqn slug()), docs, the three
// layer CTAS statements, Cube measures ({name, aggregation, column}) and upstream
// lineage edges (by dataset name; seed.mjs resolves runtime ids/FQNs).

export const DATASETS = [
  {
    name: 'Northpeak Web Sessions',
    slug: 'northpeak_web_sessions',
    description:
      'Session-grain web analytics for the Northpeak storefront — 150,000 sessions across 3 regions, ' +
      '5 products and 6 months of 2026. A session that converted carries its order value; the rest are ' +
      'abandoned (0). The base table every other Northpeak dataset derives from.',
    columns: [
      { name: 'session_id', description: 'Unique session identifier (grain). Converted sessions share the id with their order.' },
      { name: 'customer_id', description: 'Visiting customer (NP-CUST-…).' },
      { name: 'region', description: 'Storefront region (eu-central, eu-west, nordics).' },
      { name: 'product', description: 'Product the session focused on (5 Northpeak hero products).' },
      { name: 'session_date', description: 'Session date (Jan–Jun 2026).' },
      { name: 'session_month', description: 'Session month (date_trunc), the reporting grain.' },
      { name: 'converted', description: '1 if the session converted to a paid order, else 0.' },
      { name: 'net_amount', description: 'Net revenue of the converted session in EUR (0 for abandoned).' },
      { name: 'order_total', description: 'List-price order total in EUR (0 for abandoned).' },
      { name: 'is_churned', description: 'Session-level churn signal flag (feeds the customer churn base).' },
    ],
    bronzeSql:
      `create or replace table ${T('bronze', 'northpeak_web_sessions')} as ` +
      `select order_id as session_id, customer_id, region, product, net_amount, order_total, converted, ` +
      `order_date as session_date, is_churned from ${BASE_MART}`,
    silverSql:
      `create or replace table ${T('silver', 'northpeak_web_sessions')} as ` +
      `select session_id, cast(substr(session_id, 8) as bigint) as session_seq, customer_id, ` +
      `lower(region) as region, product, cast(net_amount as decimal(10,2)) as net_amount, ` +
      `cast(order_total as decimal(10,2)) as order_total, converted, session_date, is_churned ` +
      `from ${T('bronze', 'northpeak_web_sessions')}`,
    goldSql:
      `create or replace table ${T('gold', 'northpeak_web_sessions')} as ` +
      `select session_id, customer_id, region, product, session_date, ` +
      `date_trunc('month', session_date) as session_month, converted, net_amount, order_total, is_churned ` +
      `from ${T('silver', 'northpeak_web_sessions')}`,
    measures: [
      { name: 'sessions', aggregation: 'count', column: '' },
      { name: 'conversion_rate', aggregation: 'avg', column: 'converted' },
      { name: 'demand', aggregation: 'sum', column: 'net_amount' },
    ],
    upstreams: [],
  },
  {
    name: 'Northpeak Orders',
    slug: 'northpeak_orders',
    description:
      'Order facts — every converted session becomes a paid order (~4,800 orders, conversion ≈ 3.2%). ' +
      'Silver adds the discount, the reporting month and the deterministic campaign attribution ' +
      '(NP-CMP-1…6). The revenue base for the Executive Overview dashboard.',
    columns: [
      { name: 'order_id', description: 'Unique order identifier (grain), shared with the originating session.' },
      { name: 'customer_id', description: 'Ordering customer.' },
      { name: 'region', description: 'Fulfilment region (eu-central, eu-west, nordics).' },
      { name: 'product', description: 'Ordered product.' },
      { name: 'campaign_id', description: 'Attributed marketing campaign (NP-CMP-1…6).' },
      { name: 'order_date', description: 'Order date.' },
      { name: 'order_month', description: 'Order month (date_trunc), the reporting grain.' },
      { name: 'net_amount', description: 'Net revenue in EUR after discount.' },
      { name: 'order_total', description: 'List-price order total in EUR.' },
      { name: 'discount_amount', description: 'Discount in EUR (order_total − net_amount, 0–10%).' },
    ],
    bronzeSql:
      `create or replace table ${T('bronze', 'northpeak_orders')} as ` +
      `select session_id as order_id, customer_id, region, product, net_amount, order_total, ` +
      `session_date as order_date from ${T('bronze', 'northpeak_web_sessions')} where converted = 1`,
    silverSql:
      `create or replace table ${T('silver', 'northpeak_orders')} as ` +
      `select order_id, cast(substr(order_id, 8) as bigint) as order_seq, customer_id, ` +
      `lower(region) as region, product, cast(net_amount as decimal(10,2)) as net_amount, ` +
      `cast(order_total as decimal(10,2)) as order_total, ` +
      `cast(order_total - net_amount as decimal(10,2)) as discount_amount, order_date, ` +
      `date_trunc('month', order_date) as order_month, ` +
      `'NP-CMP-' || cast(1 + mod(cast(floor(cast(substr(order_id, 8) as bigint) / 7.0) as bigint), 6) as varchar) as campaign_id ` +
      `from ${T('bronze', 'northpeak_orders')}`,
    goldSql:
      `create or replace table ${T('gold', 'northpeak_orders')} as ` +
      `select order_id, customer_id, region, product, campaign_id, order_date, order_month, ` +
      `net_amount, order_total, discount_amount from ${T('silver', 'northpeak_orders')}`,
    measures: [
      { name: 'revenue', aggregation: 'sum', column: 'net_amount' },
      { name: 'orders', aggregation: 'count', column: '' },
      { name: 'aov', aggregation: 'avg', column: 'order_total' },
      { name: 'discounts', aggregation: 'sum', column: 'discount_amount' },
    ],
    upstreams: ['Northpeak Web Sessions'],
  },
  {
    name: 'Northpeak Customers',
    slug: 'northpeak_customers',
    description:
      'Customer base (~4,200 customers) with lifetime order aggregates, a value segment and the ' +
      'deterministic churn flag (≈18%). The churn base the Science tab trains on and the source of the ' +
      'churn_rate metric.',
    columns: [
      { name: 'customer_id', description: 'Unique customer identifier (grain).' },
      { name: 'region', description: 'Home region of the customer.' },
      { name: 'first_seen', description: 'First session date.' },
      { name: 'last_seen', description: 'Most recent session date.' },
      { name: 'orders_cnt', description: 'Lifetime paid orders.' },
      { name: 'lifetime_revenue', description: 'Lifetime net revenue in EUR.' },
      { name: 'segment', description: 'Value segment: loyal (2+ orders), active (1), browser (0).' },
      { name: 'churn_flag', description: '1 if the customer is churned (deterministic ≈18% base rate).' },
    ],
    bronzeSql:
      `create or replace table ${T('bronze', 'northpeak_customers')} as ` +
      `select customer_id, min(region) as region, min(session_date) as first_seen, ` +
      `max(session_date) as last_seen from ${T('bronze', 'northpeak_web_sessions')} group by customer_id`,
    silverSql:
      `create or replace table ${T('silver', 'northpeak_customers')} as ` +
      `select c.customer_id, cast(substr(c.customer_id, 9) as bigint) as customer_seq, ` +
      `lower(c.region) as region, c.first_seen, c.last_seen, coalesce(o.orders_cnt, 0) as orders_cnt, ` +
      `cast(coalesce(o.lifetime_revenue, 0) as decimal(12,2)) as lifetime_revenue, ` +
      `case when mod(cast(substr(c.customer_id, 9) as bigint) * 94379, 100000) < 18000 then 1 else 0 end as churn_flag ` +
      `from ${T('bronze', 'northpeak_customers')} c left join ` +
      `(select customer_id, count(*) as orders_cnt, sum(net_amount) as lifetime_revenue ` +
      `from ${T('silver', 'northpeak_orders')} group by customer_id) o on c.customer_id = o.customer_id`,
    goldSql:
      `create or replace table ${T('gold', 'northpeak_customers')} as ` +
      `select customer_id, region, first_seen, last_seen, orders_cnt, lifetime_revenue, ` +
      `case when orders_cnt >= 2 then 'loyal' when orders_cnt >= 1 then 'active' else 'browser' end as segment, ` +
      `churn_flag from ${T('silver', 'northpeak_customers')}`,
    measures: [
      { name: 'customers', aggregation: 'count', column: '' },
      { name: 'churn_rate', aggregation: 'avg', column: 'churn_flag' },
      { name: 'lifetime_value', aggregation: 'avg', column: 'lifetime_revenue' },
    ],
    upstreams: ['Northpeak Web Sessions', 'Northpeak Orders'],
  },
  {
    name: 'Northpeak Returns',
    slug: 'northpeak_returns',
    description:
      'Product returns — a deterministic ≈12% of orders come back within 3–24 days with one of five ' +
      'reasons; refunds are 50% or 100% of net. The returns-system export the Returns Impact join reads.',
    columns: [
      { name: 'return_id', description: 'Unique return identifier (grain).' },
      { name: 'order_id', description: 'Returned order.' },
      { name: 'customer_id', description: 'Returning customer.' },
      { name: 'region', description: 'Fulfilment region of the returned order.' },
      { name: 'product', description: 'Returned product.' },
      { name: 'return_reason', description: 'Reason (wrong size, damaged in transit, not as described, changed mind, quality issue).' },
      { name: 'return_date', description: 'Date the return was registered (3–24 days after the order).' },
      { name: 'return_month', description: 'Return month (date_trunc), the reporting grain.' },
      { name: 'refund_amount', description: 'Refunded amount in EUR (50% or 100% of the order net).' },
    ],
    bronzeSql:
      `create or replace table ${T('bronze', 'northpeak_returns')} as ` +
      `select 'NP-RET-' || cast(order_seq as varchar) as return_id, order_id, customer_id, region, product, ` +
      `cast(net_amount * (0.5 + mod(order_seq, 2) * 0.5) as decimal(10,2)) as refund_amount, ` +
      `date_add('day', 3 + mod(order_seq, 21), order_date) as return_date, ` +
      `element_at(array['wrong size', 'damaged in transit', 'not as described', 'changed mind', 'quality issue'], ` +
      `1 + mod(order_seq * 13, 5)) as return_reason ` +
      `from ${T('silver', 'northpeak_orders')} where mod(order_seq * 11, 100) < 12`,
    silverSql:
      `create or replace table ${T('silver', 'northpeak_returns')} as ` +
      `select return_id, order_id, customer_id, region, product, return_reason, return_date, ` +
      `date_trunc('month', return_date) as return_month, refund_amount ` +
      `from ${T('bronze', 'northpeak_returns')} where refund_amount > 0`,
    goldSql:
      `create or replace table ${T('gold', 'northpeak_returns')} as ` +
      `select return_id, order_id, customer_id, region, product, return_reason, return_date, ` +
      `return_month, refund_amount from ${T('silver', 'northpeak_returns')}`,
    measures: [
      { name: 'returns', aggregation: 'count', column: '' },
      { name: 'refund_total', aggregation: 'sum', column: 'refund_amount' },
      { name: 'avg_refund', aggregation: 'avg', column: 'refund_amount' },
    ],
    upstreams: ['Northpeak Orders'],
  },
  {
    name: 'Northpeak Campaigns',
    slug: 'northpeak_campaigns',
    description:
      'Marketing campaign performance — 6 campaigns × 6 months (36 cells) with deterministic media spend, ' +
      'joined against the REAL attributed orders, so spend, attributed revenue and ROAS carry genuine ' +
      'increase/cut/hold signal. Grain is campaign × month (the base mart correlates region with month, ' +
      'so a regional campaign grain would produce structural zeros — documented honesty).',
    columns: [
      { name: 'campaign_id', description: 'Campaign identifier (NP-CMP-1…6).' },
      { name: 'campaign_name', description: 'Campaign name (Peak Season Push, Trailhead Launch, …).' },
      { name: 'channel', description: 'Channel (paid_social, search, email, loyalty).' },
      { name: 'campaign_month', description: 'Campaign month (grain: campaign × month).' },
      { name: 'spend_eur', description: 'Media spend in the cell (EUR ≈7,500–19,500, deterministic).' },
      { name: 'attributed_orders', description: 'Orders attributed to the cell (from Northpeak Orders).' },
      { name: 'attributed_revenue', description: 'Net revenue attributed to the cell in EUR.' },
      { name: 'roas', description: 'Return on ad spend = attributed_revenue / spend_eur.' },
    ],
    bronzeSql:
      `create or replace table ${T('bronze', 'northpeak_campaigns')} as ` +
      `select 'NP-CMP-' || cast(c as varchar) as campaign_id, ` +
      `element_at(array['Peak Season Push', 'Trailhead Launch', 'Winter Basecamp', 'Summit Loyalty', 'Backcountry Search', 'Alpine Social'], c) as campaign_name, ` +
      `element_at(array['paid_social', 'search', 'email', 'loyalty', 'search', 'paid_social'], c) as channel, ` +
      `date_add('month', m - 1, date '2026-01-01') as campaign_month, ` +
      `cast(7500 + mod(c * 524287 + m * 40503, 12000) as decimal(10,2)) as spend_eur ` +
      `from unnest(sequence(1, 6)) as t1(c) cross join unnest(sequence(1, 6)) as t2(m)`,
    silverSql:
      `create or replace table ${T('silver', 'northpeak_campaigns')} as ` +
      `select campaign_id, campaign_name, channel, campaign_month, spend_eur ` +
      `from ${T('bronze', 'northpeak_campaigns')} where spend_eur > 0`,
    goldSql:
      `create or replace table ${T('gold', 'northpeak_campaigns')} as ` +
      `select c.campaign_id, c.campaign_name, c.channel, c.campaign_month, c.spend_eur, ` +
      `coalesce(o.attributed_orders, 0) as attributed_orders, ` +
      `cast(coalesce(o.attributed_revenue, 0) as decimal(12,2)) as attributed_revenue, ` +
      `cast(coalesce(o.attributed_revenue, 0) / c.spend_eur as decimal(10,4)) as roas ` +
      `from ${T('silver', 'northpeak_campaigns')} c left join ` +
      `(select campaign_id, order_month, count(*) as attributed_orders, ` +
      `sum(net_amount) as attributed_revenue from ${T('silver', 'northpeak_orders')} ` +
      `group by campaign_id, order_month) o ` +
      `on c.campaign_id = o.campaign_id and c.campaign_month = o.order_month`,
    measures: [
      { name: 'spend', aggregation: 'sum', column: 'spend_eur' },
      { name: 'attributed_revenue', aggregation: 'sum', column: 'attributed_revenue' },
      { name: 'roas', aggregation: 'avg', column: 'roas' },
    ],
    upstreams: ['Northpeak Orders'],
  },
  {
    name: 'Northpeak Returns Impact',
    slug: 'northpeak_returns_impact',
    description:
      'The Gold-join capstone: orders LEFT JOIN returns aggregated to region × product × month — revenue, ' +
      'refunds, net revenue after returns and the return rate. The worked example of stage-4 dataset ' +
      'reuse students replicate in their own personal lane.',
    columns: [
      { name: 'region', description: 'Region (grain part 1).' },
      { name: 'product', description: 'Product (grain part 2).' },
      { name: 'order_month', description: 'Order month (grain part 3).' },
      { name: 'orders', description: 'Orders in the cell.' },
      { name: 'revenue', description: 'Net revenue in EUR.' },
      { name: 'returns', description: 'Returns registered against the cell.' },
      { name: 'refund_total', description: 'Refunded EUR.' },
      { name: 'net_revenue_after_returns', description: 'Revenue − refunds, in EUR.' },
      { name: 'return_rate', description: 'Returns / orders in the cell.' },
    ],
    // The join mart's own medallion: bronze = the raw joined order↔return rows,
    // silver = cleaned + returned flag, gold = the region × product × month rollup.
    bronzeSql:
      `create or replace table ${T('bronze', 'northpeak_returns_impact')} as ` +
      `select o.order_id, o.customer_id, o.region, o.product, o.order_month, o.net_amount, ` +
      `r.return_id, r.refund_amount from ${T('gold', 'northpeak_orders')} o ` +
      `left join ${T('gold', 'northpeak_returns')} r on o.order_id = r.order_id`,
    silverSql:
      `create or replace table ${T('silver', 'northpeak_returns_impact')} as ` +
      `select order_id, customer_id, region, product, order_month, net_amount, return_id, ` +
      `coalesce(refund_amount, 0) as refund_amount, ` +
      `case when return_id is not null then 1 else 0 end as returned ` +
      `from ${T('bronze', 'northpeak_returns_impact')}`,
    goldSql:
      `create or replace table ${T('gold', 'northpeak_returns_impact')} as ` +
      `select region, product, order_month, count(*) as orders, ` +
      `cast(sum(net_amount) as decimal(12,2)) as revenue, sum(returned) as returns, ` +
      `cast(sum(refund_amount) as decimal(12,2)) as refund_total, ` +
      `cast(sum(net_amount) - sum(refund_amount) as decimal(12,2)) as net_revenue_after_returns, ` +
      `cast(sum(returned) as double) / count(*) as return_rate ` +
      `from ${T('silver', 'northpeak_returns_impact')} group by region, product, order_month`,
    measures: [
      { name: 'net_revenue_after_returns', aggregation: 'sum', column: 'net_revenue_after_returns' },
      { name: 'return_rate', aggregation: 'avg', column: 'return_rate' },
      { name: 'refunds', aggregation: 'sum', column: 'refund_total' },
    ],
    upstreams: ['Northpeak Orders', 'Northpeak Returns'],
  },
];

// -------------------------------------------------------- ordered statements ----
/** Everything marts.mjs executes, in dependency order: schema first, then each
 *  dataset's bronze→silver→gold in DATASETS order (dataset-major, so a later
 *  dataset may read any earlier dataset's layers; every FROM only references the
 *  base mart or an earlier target — marts.test.mjs proves this mechanically). */
export function martStatements() {
  const stmts = [{ kind: 'schema', target: `iceberg.${DOMAIN}`, sql: `create schema if not exists iceberg.${DOMAIN}` }];
  for (const d of DATASETS) {
    for (const layer of ['bronze', 'silver', 'gold']) {
      const sql = d[`${layer}Sql`];
      if (sql) stmts.push({ kind: 'ctas', target: T(layer, d.slug), sql });
    }
  }
  return stmts;
}

/** Physical gold tables — the verify set (each must count > 0 after the run). */
export const GOLD_TABLES = DATASETS.map((d) => T('gold', d.slug));

// ----------------------------------------------------------------- dashboards ---
// Members follow the platform contract: `<view without spaces>.<measure|column>`
// where view = cubeViewName(dataset) = the dataset name (already clean).
const member = (dsName, m) => `${dsName.replace(/[^A-Za-z0-9]+/g, ' ').trim().replace(/\s+/g, '')}.${m}`;

export const DASHBOARDS = [
  {
    id: 'northpeak-executive-overview',
    name: 'Northpeak Executive Overview',
    dataset: 'Northpeak Orders',
    charts: [
      { name: 'Revenue', vizType: 'big_number_total', metric: member('Northpeak Orders', 'revenue') },
      { name: 'Revenue by month', vizType: 'line', metric: member('Northpeak Orders', 'revenue'), dimensions: [member('Northpeak Orders', 'order_month')] },
      { name: 'Average order value', vizType: 'big_number_total', metric: member('Northpeak Orders', 'aov') },
      { name: 'Revenue by region', vizType: 'bar', metric: member('Northpeak Orders', 'revenue'), dimensions: [member('Northpeak Orders', 'region')] },
      { name: 'Orders by product', vizType: 'bar', metric: member('Northpeak Orders', 'orders'), dimensions: [member('Northpeak Orders', 'product')] },
    ],
  },
  {
    id: 'northpeak-returns-retention',
    name: 'Northpeak Returns & Retention',
    dataset: 'Northpeak Returns Impact',
    charts: [
      { name: 'Net revenue after returns', vizType: 'big_number_total', metric: member('Northpeak Returns Impact', 'net_revenue_after_returns') },
      { name: 'Return rate by product', vizType: 'bar', metric: member('Northpeak Returns Impact', 'return_rate'), dimensions: [member('Northpeak Returns Impact', 'product')] },
      { name: 'Refunds by month', vizType: 'line', metric: member('Northpeak Returns Impact', 'refunds'), dimensions: [member('Northpeak Returns Impact', 'order_month')] },
    ],
  },
  {
    id: 'northpeak-campaign-performance',
    name: 'Northpeak Campaign Performance',
    dataset: 'Northpeak Campaigns',
    charts: [
      { name: 'Spend', vizType: 'big_number_total', metric: member('Northpeak Campaigns', 'spend') },
      { name: 'Attributed revenue by month', vizType: 'line', metric: member('Northpeak Campaigns', 'attributed_revenue'), dimensions: [member('Northpeak Campaigns', 'campaign_month')] },
      { name: 'ROAS by channel', vizType: 'bar', metric: member('Northpeak Campaigns', 'roas'), dimensions: [member('Northpeak Campaigns', 'channel')] },
    ],
  },
];
