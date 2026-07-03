/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Data Masterclass
 *
 * The e-commerce case study — ONE coherent story, as plain data. Northpeak is a
 * fictional online outdoor-and-apparel retailer. The seed drives the platform's
 * governed flows with this content so every tab ends up holding REAL, linked
 * artifacts: the dashboard uses a metric, the metric uses the Gold mart, the Gold
 * mart uses the ingested orders; the "Reduce churn" bet bundles the churn model +
 * the Customer Health dashboard under the Retention pillar.
 *
 * IDs that the platform mints at runtime (dataset id, metric member, agent system
 * id, …) are NOT here — the seed captures them from each create call and threads
 * them into the next, which is how cross-tab lineage is built for real.
 */

export const STORE = {
  name: 'Northpeak',
  tagline: 'Online outdoor & apparel retailer',
  tenant: 'data-masterclass',
};

/**
 * The cast — governed identities. These are the SAME rows that go into OS_USERS
 * (operator pre-seed); the seed logs in AS them so role-scoped governance is
 * exercised end to end. Passwords are NOT here — they are generated into a
 * gitignored credentials file by gen-credentials.mjs and supplied at run time.
 */
// `id` is the internal principal (owner/OPA/DLS key); `email` is the human
// sign-in label (login-by-email). Both resolve the same account.
export const CAST = [
  { id: 'nova-admin', name: 'Nova (Store Admin)', email: 'nova@northpeak.demo', role: 'admin', domains: ['platform', 'sales', 'marketing', 'ops'] },
  { id: 'sasha-sales', name: 'Sasha (Sales Builder)', email: 'sasha@northpeak.demo', role: 'builder', domains: ['sales'] },
  { id: 'morgan-mktg', name: 'Morgan (Marketing Builder)', email: 'morgan@northpeak.demo', role: 'builder', domains: ['marketing'] },
  { id: 'omar-ops', name: 'Omar (Ops Builder)', email: 'omar@northpeak.demo', role: 'builder', domains: ['ops'] },
  { id: 'riley-sales', name: 'Riley (Sales Creator)', email: 'riley@northpeak.demo', role: 'creator', domains: ['sales'] },
  { id: 'kai-mktg', name: 'Kai (Marketing Creator)', email: 'kai@northpeak.demo', role: 'creator', domains: ['marketing'] },
  { id: 'devi-ops', name: 'Devi (Ops Creator)', email: 'devi@northpeak.demo', role: 'creator', domains: ['ops'] },
];

/** Connections — a mock store Postgres, a Drive, and an MCP. */
export const CONNECTIONS = [
  {
    key: 'database', // CONNECTION_TEMPLATES key → type Database
    name: 'northpeak-orders-db',
    endpoint: 'postgresql://northpeak.db.svc:5432/commerce',
    credential: 'demo-db-password-not-real',
    domain: 'sales',
    actor: 'sasha-sales',
  },
  {
    key: 'gdrive',
    name: 'northpeak-drive',
    endpoint: 'https://drive.google.com/drive/folders/northpeak-ops',
    credential: 'demo-oauth-token-not-real',
    domain: 'ops',
    actor: 'omar-ops',
  },
  {
    key: 'generic-mcp',
    name: 'northpeak-support-mcp',
    endpoint: 'https://mcp.northpeak.demo/sse',
    credential: 'demo-mcp-token-not-real',
    domain: 'ops',
    actor: 'omar-ops',
  },
];

/** Files — product catalog, return-policy PDF (as text), support-call transcript. */
export const FILES = [
  {
    name: 'northpeak-product-catalog.md',
    folder: 'catalog',
    tags: ['catalog', 'products'],
    sensitivity: 'internal',
    actor: 'kai-mktg',
    text: [
      '# Northpeak Product Catalog (Spring 2026)',
      '',
      '| SKU | Product | Category | Price (EUR) |',
      '| --- | --- | --- | --- |',
      '| NP-JK-001 | Ridgeline 3-Season Jacket | Outerwear | 189.00 |',
      '| NP-TN-014 | Summit 2P Tent | Shelter | 329.00 |',
      '| NP-BT-027 | Trailhead GTX Boots | Footwear | 159.00 |',
      '| NP-BP-009 | Cascade 45L Backpack | Packs | 139.00 |',
      '| NP-IN-052 | Basecamp Down Quilt | Sleep | 249.00 |',
      '',
      'Bestsellers ship from the EU-Central warehouse. Bundles (Tent + Quilt)',
      'carry a 10% discount and drive a higher average order value.',
    ].join('\n'),
  },
  {
    name: 'northpeak-return-policy.md',
    folder: 'policies',
    tags: ['policy', 'returns'],
    sensitivity: 'internal',
    actor: 'omar-ops',
    text: [
      '# Northpeak Returns & Refunds Policy',
      '',
      '1. Unused items may be returned within 30 days for a full refund.',
      '2. Worn footwear is inspected; a 15% restocking fee may apply.',
      '3. Refunds are issued to the original payment method within 5 business days.',
      '4. Orders flagged by the fraud check are held pending manual review before',
      '   any refund is released.',
      '5. Bundle returns must include all bundle items to qualify for the full refund.',
    ].join('\n'),
  },
  {
    name: 'northpeak-support-call-0142.txt',
    folder: 'transcripts',
    tags: ['support', 'transcript', 'returns'],
    sensitivity: 'confidential',
    actor: 'devi-ops',
    text: [
      'Support Call #0142 — transcript',
      'Customer: I want to return the Summit 2P tent, one pole arrived bent.',
      'Agent: I am sorry to hear that. Since it is within 30 days and the item is',
      '       defective, I can issue a full refund with no restocking fee.',
      'Customer: Great. Same card I paid with?',
      'Agent: Yes, 5 business days. I have logged a defect note against SKU NP-TN-014.',
      'Customer: Thank you.',
      'Agent: A prepaid return label is on its way to your email. Have a good day.',
    ].join('\n'),
  },
];

/**
 * The Data mart — Northpeak commerce, built Bronze→Silver→Gold. The dbt bodies are
 * illustrative but real text the platform stores as the layer artifacts. Gold is
 * the revenue + churn base every metric reads.
 */
export const DATASET = {
  name: 'northpeak-commerce',
  domain: 'sales',
  creator: 'riley-sales',
  builder: 'sasha-sales',
  silverSql: [
    '-- silver: clean + conform raw orders/customers/products',
    'select',
    '  o.order_id,',
    '  o.customer_id,',
    "  lower(trim(c.region)) as region,",
    '  p.product,',
    '  o.net_amount,',
    '  o.order_total,',
    '  o.converted,',
    '  o.order_month',
    'from {{ ref("bronze_orders") }} o',
    'join {{ ref("bronze_customers") }} c using (customer_id)',
    'join {{ ref("bronze_products") }} p using (sku)',
    'where o.net_amount >= 0',
  ].join('\n'),
  goldSql: [
    '-- gold: revenue + churn base mart (one row per order, churn flag per customer)',
    'select',
    '  order_id,',
    '  customer_id,',
    '  region,',
    '  product,',
    '  net_amount,',
    '  order_total,',
    '  converted,',
    '  order_month,',
    '  case when last_order_age_days > 90 then 1 else 0 end as is_churned',
    'from {{ ref("silver_orders") }}',
    'left join {{ ref("customer_recency") }} using (customer_id)',
  ].join('\n'),
  description:
    'Northpeak order-level revenue and churn base mart. One row per order with ' +
    'region/product dimensions, net revenue, order total, conversion flag and a ' +
    'per-customer churn flag (no order in 90 days).',
  columns: [
    { name: 'order_id', description: 'Unique order identifier (grain of the mart).' },
    { name: 'customer_id', description: 'Customer who placed the order.' },
    { name: 'region', description: 'Customer region (eu-central, eu-west, nordics).' },
    { name: 'product', description: 'Product name from the catalog.' },
    { name: 'net_amount', description: 'Net revenue for the order in EUR (post-discount).' },
    { name: 'order_total', description: 'Gross order total in EUR (drives AOV).' },
    { name: 'converted', description: '1 if the session converted to a paid order, else 0.' },
    { name: 'order_month', description: 'Month of the order (time dimension).' },
    { name: 'is_churned', description: '1 if the customer has not ordered in 90 days.' },
  ],
};

/** Metrics on the Gold mart (Cube semantic layer). */
export const METRICS = [
  { name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: ['region', 'product'] },
  { name: 'AOV', aggregation: 'avg', column: 'order_total', dimensions: ['region'] },
  { name: 'Conversion', aggregation: 'avg', column: 'converted', dimensions: ['region'] },
  { name: 'ChurnRate', aggregation: 'avg', column: 'is_churned', dimensions: ['region'] },
];

/** Knowledge — governed workflows + a tacit note. */
export const WORKFLOWS = [
  {
    title: 'Handle a return',
    domain: 'ops',
    actor: 'devi-ops',
    publisher: 'omar-ops',
    tacit:
      'In practice: defective items skip the restocking fee even outside the ' +
      'letter of the policy if the defect is logged against the SKU. Bent tent ' +
      'poles (NP-TN-014) are a known batch issue — auto-approve the refund.',
  },
  {
    title: 'Fraud check',
    domain: 'ops',
    actor: 'devi-ops',
    publisher: 'omar-ops',
    tacit:
      'Hold any order where billing region != shipping region AND order_total > ' +
      '300 EUR for manual review. Most true fraud in our data clusters in the ' +
      'first order from a new customer paying with a mismatched region.',
  },
];

export const KNOWLEDGE_DOCS = [
  {
    title: 'Northpeak returns SLA',
    text: 'Refunds are issued within 5 business days. Fraud-flagged orders are held for manual review before any refund is released.',
  },
];

/**
 * Agents — three governed systems. `grants` reference ids the seed resolves at
 * run time (data: the Gold dataset; knowledge: the workflow; connections: the
 * MCP/db; tools: governed MCP tools incl. `predict`). The seed fills the
 * placeholders, writes system.yaml via the governed file API, then Build + Run.
 */
export const AGENTS = [
  {
    name: 'Northpeak Support Agent',
    domain: 'ops',
    owner: 'omar-ops',
    entrypoint: 'support',
    agent: {
      id: 'support',
      role: 'Customer support for returns and refunds',
      agent_md:
        '# Support Agent\nYou handle Northpeak return and refund requests. Follow the ' +
        '"Handle a return" workflow and the published returns policy. Defer fraud-flagged ' +
        'orders to manual review. Be concise and kind.',
    },
    grantTools: ['knowledge_search'],
    grantKnowledge: ['{{handle_a_return}}'],
    grantConnections: [{ id: '{{support_mcp}}', capability: 'Read' }],
    runPrompt: 'A customer wants to return a Summit 2P tent with a bent pole within 14 days. What do we do?',
  },
  {
    name: 'Northpeak Fraud Agent',
    domain: 'ops',
    owner: 'omar-ops',
    entrypoint: 'fraud',
    agent: {
      id: 'fraud',
      role: 'Fraud screening for new orders',
      agent_md:
        '# Fraud Agent\nScreen orders using the "Fraud check" workflow. Hold orders where ' +
        'billing region != shipping region and order_total > 300 EUR. Call the churn/predict ' +
        'tool only for risk context, never to auto-refund.',
    },
    grantTools: ['knowledge_search', 'predict'],
    grantKnowledge: ['{{fraud_check}}'],
    grantData: ['{{gold_dataset}}'],
    runPrompt: 'A first-time customer in eu-west placed a 420 EUR order shipping to nordics. Screen it.',
  },
  {
    name: 'Northpeak Pricing Agent',
    domain: 'sales',
    owner: 'sasha-sales',
    entrypoint: 'pricing',
    agent: {
      id: 'pricing',
      role: 'Bundle pricing and AOV optimisation',
      agent_md:
        '# Pricing Agent\nRecommend bundle discounts that lift average order value without ' +
        'eroding margin. Read the Revenue and AOV metrics from the governed mart before ' +
        'proposing a change.',
    },
    grantTools: ['metrics_query'],
    grantData: ['{{gold_dataset}}'],
    runPrompt: 'Propose a Tent + Quilt bundle discount that lifts AOV in eu-central.',
  },
];

/**
 * Science — the churn model vertical slice (model-as-service), driven through its
 * real governed lifecycle: promote (Personal→Domain) → go-live (Staging→Prod) →
 * certify (Domain→Marketplace) → predict. Demand forecast is registered as a
 * second consumption via retrain when the live ml-agent is present.
 */
export const SCIENCE = {
  churnModel: 'churn_model', // the platform's seeded churn model id (lib/science CHURN.model)
  certifyMode: 'read-in-place',
  predictAccount: 'NP-CUST-3391',
  predictFeatures: { recency_days: 104, orders_12m: 1, avg_order_value: 142, support_tickets: 2 },
};

/**
 * Big Bets — bundle real components (the model + a dashboard + a metric) so value
 * rolls up. The create flow now captures an Owner, ONE free-form Problem Statement,
 * a Solution Idea, the value (target + basis), and a Planned Go-Live; the bet's
 * display NAME is DERIVED server-side from the problem statement (no name field),
 * so each `problem` keeps a short, clean first sentence. Component `artifactId`s
 * (the `{{…}}` refs) are resolved by the seed at run time.
 */
export const BIG_BETS = [
  {
    key: 'reduce_churn',
    label: 'Reduce churn', // console label only; the real name is derived
    actor: 'nova-admin', // the session that creates + owns the bet
    owner: 'Sasha Nilsson (Sales)', // the create form's Owner field
    problem:
      'Repeat customers lapse after one season. We get no early signal on who is ' +
      'about to churn, so retained revenue leaks every quarter.',
    solution:
      'Stand up a churn-risk model feeding a Customer Health dashboard so Sales can ' +
      'intervene with the right offer before a customer lapses.',
    domain: 'sales',
    pillarId: 'pillar_retention',
    targetValue: 240000,
    valueBasis: 'uplift',
    goLive: '2026-09-30',
    pillar: 'Retention',
    components: [
      { tab: 'ml', title: 'Churn prediction model', ref: '{{churn_model}}' },
      { tab: 'dashboard', title: 'Customer Health dashboard', ref: '{{customer_health_dashboard}}' },
      { tab: 'metric', title: 'Churn rate metric', ref: '{{churnrate_metric}}' },
    ],
  },
  {
    key: 'increase_aov',
    label: 'Increase AOV',
    actor: 'nova-admin',
    owner: 'Sasha Nilsson (Sales)',
    problem:
      'Checkout baskets stay flat at one item. Shoppers never discover relevant ' +
      'bundles, so average order value stalls below plan.',
    solution:
      'Use a pricing agent reading the Revenue + AOV metrics to surface bundle ' +
      'offers that lift average order value at checkout without eroding margin.',
    domain: 'sales',
    pillarId: 'pillar_growth',
    targetValue: 180000,
    valueBasis: 'uplift',
    goLive: '2026-10-31',
    pillar: 'Growth',
    components: [
      { tab: 'metric', title: 'AOV metric', ref: '{{aov_metric}}' },
      { tab: 'dashboard', title: 'Sales Overview dashboard', ref: '{{sales_overview_dashboard}}' },
      { tab: 'agent', title: 'Pricing agent', ref: '{{pricing_agent}}' },
    ],
  },
];

/**
 * Strategy — two tenant pillars, each carrying a business value metric. Strategy
 * now keeps each pillar's number one of two ways (the seed demonstrates BOTH):
 *   • Retention → GOVERNED: the value flows from a governed Cube metric (offline:
 *     seedTotal − baseline = €240k uplift), set up in the Metrics tab.
 *   • Growth → MANUAL: the company records the monthly number right here in
 *     Strategy; those entries feed the headline total AND the value-history chart.
 * Bets link in (via the bets-bridge stub) so value rolls up pillar ← bet ← parts.
 */
export const PILLARS = [
  {
    name: 'Retention',
    description: 'Keep more revenue each season — reduce churn.',
    scope: 'tenant',
    owner: 'nova-admin',
    valueMode: 'governed',
    valueMetric: {
      name: 'Retained Revenue',
      description: 'Revenue retained vs. the captured baseline as churn falls.',
    },
    metrics: [
      { title: 'Retained Revenue', basis: 'uplift', baseline: 1800000, seedTotal: 2040000 },
    ],
    bet: 'reduce_churn',
  },
  {
    name: 'Growth',
    description: 'Grow basket size and new-customer revenue.',
    scope: 'tenant',
    owner: 'nova-admin',
    valueMode: 'manual',
    valueMetric: {
      name: 'Net New Revenue',
      description: 'New-customer + basket-uplift revenue, entered monthly.',
    },
    // Manual monthly entries → headline total (newest) + value-history series.
    valueEntries: [
      { month: '2026-03', value: 2400000 },
      { month: '2026-04', value: 2460000 },
      { month: '2026-05', value: 2520000 },
      { month: '2026-06', value: 2580000 },
    ],
    bet: 'increase_aov',
  },
];
