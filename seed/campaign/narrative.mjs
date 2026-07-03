/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Data Masterclass
 *
 * The Campaign-Optimization Big Bet case study — "Northpeak Unlimited", a
 * fictional mid-sized European omnichannel retailer (home / lifestyle / consumer
 * electronics / small appliances across DE/AT/CH/NL/BE). This is the raw material
 * for the course exercise: the Agentic-Leader cohort CONSUME these domain-Shared datasets,
 * knowledge and files and BUILD their own agents to recommend campaign-budget
 * next-best-actions (INCREASE / CUT / HOLD budget for X days + reasoning).
 *
 * All content is plain data. The seed (`seed.mjs`) drives the platform's governed
 * flows with it so the Data / Knowledge / Files / Agents / Software tabs end up
 * holding REAL, governed, cross-linked artifacts in the `agentic-leader-q3-2026` domain.
 *
 * NOTE: this is a SEPARATE narrative from the e-commerce (outdoor-retailer) seed —
 * it only reuses that module's zero-dependency governed-API client, nothing else.
 */

export const STORE = {
  name: 'Northpeak Unlimited',
  tagline: 'European omnichannel retailer — home, lifestyle, electronics',
  tenant: 'data-masterclass',
};

/** The single shared workspace domain for all course materials + participants. */
export const DOMAIN = 'agentic-leader-q3-2026';

// -------------------------------------------------------------------- the cast --
// NO participant PII lives here. The real Q3-2026 roster is generated from the
// gitignored roster.private.csv into os-users.seed.json (see gen-credentials.mjs)
// and seeded into the OS via OS_USERS / osUI.usersSeed. This module keeps only
// the instructor identity + the domain constant + the (PII-free) exercise
// MATERIALS below. One operator (the instructor, a Builder) authors + shares
// every material; the Agentic-Leader participants consume them and build their
// OWN agents. Passwords are never here — gen-credentials.mjs emits them into a
// gitignored credentials file supplied at run time.
export const INSTRUCTOR = {
  id: 'alp-instructor',
  name: 'ALP Instructor',
  email: 'alp-instructor@datamasterclass.com',
  role: 'builder',
  domains: [DOMAIN],
};

// ------------------------------------------------------ deterministic synthetic --
// A tiny seeded PRNG (mulberry32) so every run generates byte-identical CSVs — the
// seed stays idempotent and the numbers are stable across the cohort.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260627);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const round2 = (x) => Math.round(x * 100) / 100;

const COUNTRIES = ['DE', 'AT', 'CH', 'NL', 'BE'];

// ------------------------------------------------------------- campaign_master --
// 10 campaigns with intentionally-shaped economics so the exercise has clear
// INCREASE / CUT / HOLD signal once CAC/COS and margins are read together.
export const CAMPAIGNS = [
  { campaign_id: 'CMP-1001', campaign_name: 'Spring Home Refresh DE', channel: 'paid_social', product_category: 'home', customer_segment: 'existing_lapsed', content_theme: 'seasonal_refresh', budget_eur: 45000, start_date: '2026-03-01', end_date: '2026-04-15', target_kpi: 'new_customers', target_value: 900 },
  { campaign_id: 'CMP-1002', campaign_name: 'Back-to-School Electronics NL', channel: 'search', product_category: 'electronics', customer_segment: 'new', content_theme: 'value_bundles', budget_eur: 60000, start_date: '2026-08-01', end_date: '2026-09-15', target_kpi: 'nmv_eur', target_value: 380000 },
  { campaign_id: 'CMP-1003', campaign_name: 'Cozy Living CH', channel: 'display', product_category: 'lifestyle', customer_segment: 'existing_active', content_theme: 'lifestyle_story', budget_eur: 22000, start_date: '2026-04-01', end_date: '2026-05-15', target_kpi: 'cos_pct', target_value: 18 },
  { campaign_id: 'CMP-1004', campaign_name: 'Smart Kitchen AT', channel: 'paid_social', product_category: 'small_appliances', customer_segment: 'new', content_theme: 'product_demo', budget_eur: 38000, start_date: '2026-05-01', end_date: '2026-06-15', target_kpi: 'new_customers', target_value: 720 },
  { campaign_id: 'CMP-1005', campaign_name: 'Weekend Deals BE', channel: 'email', product_category: 'home', customer_segment: 'existing_active', content_theme: 'flash_sale', budget_eur: 12000, start_date: '2026-04-10', end_date: '2026-05-10', target_kpi: 'nmv_eur', target_value: 140000 },
  { campaign_id: 'CMP-1006', campaign_name: 'Premium Audio DE', channel: 'search', product_category: 'electronics', customer_segment: 'existing_active', content_theme: 'premium_upgrade', budget_eur: 54000, start_date: '2026-06-01', end_date: '2026-07-15', target_kpi: 'cos_pct', target_value: 16 },
  { campaign_id: 'CMP-1007', campaign_name: 'Home Office NL', channel: 'display', product_category: 'home', customer_segment: 'new', content_theme: 'work_from_home', budget_eur: 30000, start_date: '2026-03-15', end_date: '2026-04-30', target_kpi: 'new_customers', target_value: 500 },
  { campaign_id: 'CMP-1008', campaign_name: 'Affiliate Lifestyle Push CH', channel: 'affiliate', product_category: 'lifestyle', customer_segment: 'new', content_theme: 'creator_collab', budget_eur: 26000, start_date: '2026-05-20', end_date: '2026-07-01', target_kpi: 'nmv_eur', target_value: 150000 },
  { campaign_id: 'CMP-1009', campaign_name: 'Winter Prep Appliances AT', channel: 'paid_social', product_category: 'small_appliances', customer_segment: 'existing_lapsed', content_theme: 'win_back', budget_eur: 40000, start_date: '2026-06-10', end_date: '2026-07-25', target_kpi: 'new_customers', target_value: 600 },
  { campaign_id: 'CMP-1010', campaign_name: 'Clearance Electronics BE', channel: 'email', product_category: 'electronics', customer_segment: 'existing_active', content_theme: 'clearance', budget_eur: 18000, start_date: '2026-04-20', end_date: '2026-05-20', target_kpi: 'cos_pct', target_value: 22 },
];

// -------------------------------------------------------------------- cac_cos --
// Monthly cost-of-sales / customer-acquisition-cost per campaign. Hand-shaped so
// the rules resolve to a clear next-best-action:
//   INCREASE — COS < target, CAC healthy, margin positive (1002, 1005, 1006)
//   CUT      — CAC blown out / COS > target / margin thin (1003, 1008, 1009)
//   HOLD     — mixed / within guardrails (1001, 1004, 1007, 1010)
export const CAC_COS = [
  { campaign_id: 'CMP-1001', period_month: '2026-03', spend_eur: 22000, new_customers: 300, cac_eur: 73.33, revenue_eur: 104000, cos_pct: 21.2 },
  { campaign_id: 'CMP-1001', period_month: '2026-04', spend_eur: 23000, new_customers: 330, cac_eur: 69.70, revenue_eur: 112000, cos_pct: 20.5 },
  { campaign_id: 'CMP-1002', period_month: '2026-08', spend_eur: 30000, new_customers: 620, cac_eur: 48.39, revenue_eur: 205000, cos_pct: 14.6 },
  { campaign_id: 'CMP-1002', period_month: '2026-09', spend_eur: 30000, new_customers: 610, cac_eur: 49.18, revenue_eur: 198000, cos_pct: 15.2 },
  { campaign_id: 'CMP-1003', period_month: '2026-04', spend_eur: 11000, new_customers: 70, cac_eur: 157.14, revenue_eur: 42000, cos_pct: 26.2 },
  { campaign_id: 'CMP-1003', period_month: '2026-05', spend_eur: 11000, new_customers: 66, cac_eur: 166.67, revenue_eur: 40000, cos_pct: 27.5 },
  { campaign_id: 'CMP-1004', period_month: '2026-05', spend_eur: 19000, new_customers: 340, cac_eur: 55.88, revenue_eur: 96000, cos_pct: 19.8 },
  { campaign_id: 'CMP-1004', period_month: '2026-06', spend_eur: 19000, new_customers: 355, cac_eur: 53.52, revenue_eur: 99000, cos_pct: 19.2 },
  { campaign_id: 'CMP-1005', period_month: '2026-04', spend_eur: 6000, new_customers: 210, cac_eur: 28.57, revenue_eur: 74000, cos_pct: 8.1 },
  { campaign_id: 'CMP-1005', period_month: '2026-05', spend_eur: 6000, new_customers: 205, cac_eur: 29.27, revenue_eur: 71000, cos_pct: 8.5 },
  { campaign_id: 'CMP-1006', period_month: '2026-06', spend_eur: 27000, new_customers: 240, cac_eur: 112.50, revenue_eur: 205000, cos_pct: 13.2 },
  { campaign_id: 'CMP-1006', period_month: '2026-07', spend_eur: 27000, new_customers: 250, cac_eur: 108.00, revenue_eur: 214000, cos_pct: 12.6 },
  { campaign_id: 'CMP-1007', period_month: '2026-03', spend_eur: 15000, new_customers: 250, cac_eur: 60.00, revenue_eur: 78000, cos_pct: 19.2 },
  { campaign_id: 'CMP-1007', period_month: '2026-04', spend_eur: 15000, new_customers: 245, cac_eur: 61.22, revenue_eur: 76000, cos_pct: 19.7 },
  { campaign_id: 'CMP-1008', period_month: '2026-06', spend_eur: 13000, new_customers: 95, cac_eur: 136.84, revenue_eur: 58000, cos_pct: 22.4 },
  { campaign_id: 'CMP-1008', period_month: '2026-07', spend_eur: 13000, new_customers: 88, cac_eur: 147.73, revenue_eur: 54000, cos_pct: 24.1 },
  { campaign_id: 'CMP-1009', period_month: '2026-06', spend_eur: 20000, new_customers: 150, cac_eur: 133.33, revenue_eur: 82000, cos_pct: 24.4 },
  { campaign_id: 'CMP-1009', period_month: '2026-07', spend_eur: 20000, new_customers: 140, cac_eur: 142.86, revenue_eur: 79000, cos_pct: 25.3 },
  { campaign_id: 'CMP-1010', period_month: '2026-04', spend_eur: 9000, new_customers: 180, cac_eur: 50.00, revenue_eur: 41000, cos_pct: 22.0 },
  { campaign_id: 'CMP-1010', period_month: '2026-05', spend_eur: 9000, new_customers: 175, cac_eur: 51.43, revenue_eur: 39000, cos_pct: 22.6 },
];

// ------------------------------------------------- generated txns + customers --
/** ~300 order-level margin/sales transactions, generated deterministically. */
function generateTransactions() {
  const rows = [];
  let seq = 88001;
  for (const c of CAMPAIGNS) {
    const orders = 25 + Math.floor(rnd() * 12); // 25–36 orders per campaign
    for (let i = 0; i < orders; i++) {
      const country = pick(COUNTRIES);
      const gmv = round2(45 + rnd() * 420);
      const discount = round2(gmv * (rnd() * 0.18));
      const nmv = round2(gmv - discount);
      const cogs = round2(nmv * (0.55 + rnd() * 0.15));
      const margin = round2(nmv - cogs);
      const isNew = c.customer_segment === 'new' ? (rnd() < 0.8 ? 1 : 0) : rnd() < 0.25 ? 1 : 0;
      const month = c.start_date.slice(0, 7);
      const day = String(1 + Math.floor(rnd() * 27)).padStart(2, '0');
      rows.push({
        order_id: `ORD-${seq++}`,
        campaign_id: c.campaign_id,
        order_date: `${month}-${day}`,
        country,
        gmv_eur: gmv,
        discount_eur: discount,
        nmv_eur: nmv,
        cogs_eur: cogs,
        gross_margin_eur: margin,
        is_new_customer: isNew,
      });
    }
  }
  return rows;
}

/** ~100 customers, some acquired by the campaigns above. */
function generateCustomers() {
  const rows = [];
  const segments = ['new', 'existing_active', 'existing_lapsed'];
  for (let i = 0; i < 100; i++) {
    const id = `CU-${50011 + i}`;
    const country = pick(COUNTRIES);
    const segment = pick(segments);
    const orders = segment === 'new' ? 1 : 1 + Math.floor(rnd() * 9);
    const nmv = round2(orders * (60 + rnd() * 180));
    const acq = pick(CAMPAIGNS).campaign_id;
    const signupMonth = pick(['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04']);
    const lastMonth = pick(['2026-03', '2026-04', '2026-05', '2026-06']);
    rows.push({
      customer_id: id,
      signup_date: `${signupMonth}-15`,
      country,
      segment,
      lifetime_orders: orders,
      lifetime_nmv_eur: nmv,
      last_order_date: `${lastMonth}-10`,
      acquisition_campaign_id: acq,
    });
  }
  return rows;
}

export const TRANSACTIONS = generateTransactions();
export const CUSTOMERS = generateCustomers();

// --------------------------------------------------------------- CSV helpers --
function toCsv(headers, rows) {
  const head = headers.join(',');
  const body = rows.map((r) => headers.map((h) => r[h]).join(',')).join('\n');
  return `${head}\n${body}\n`;
}

// --------------------------------------------------- 4 governed datasets (a) --
// Created via the governed Data endpoints for CATALOG / LINEAGE / agent-grants.
// (Physical Trino/Cube marts are deferred, so metric *values* are honest-mock; the
// actual ROWS are seeded as domain-Shared Files below — the working agent path.)
export const DATASETS = [
  {
    name: 'campaign_master',
    domain: DOMAIN,
    description: 'Master registry of Northpeak Unlimited marketing campaigns — one row per campaign with budget, channel, product category, target customer segment, content theme and the primary target KPI.',
    columns: [
      { name: 'campaign_id', description: 'Unique campaign identifier (grain).' },
      { name: 'campaign_name', description: 'Human-readable campaign name.' },
      { name: 'channel', description: 'Marketing channel (paid_social, search, display, email, affiliate).' },
      { name: 'product_category', description: 'Primary category (home, lifestyle, electronics, small_appliances).' },
      { name: 'customer_segment', description: 'Target segment (new, existing_active, existing_lapsed).' },
      { name: 'content_theme', description: 'Creative theme of the campaign.' },
      { name: 'budget_eur', description: 'Total allocated budget in EUR.' },
      { name: 'start_date', description: 'Campaign start date.' },
      { name: 'end_date', description: 'Campaign end date.' },
      { name: 'target_kpi', description: 'Primary success KPI (new_customers, nmv_eur, cos_pct).' },
      { name: 'target_value', description: 'Target value for the primary KPI.' },
    ],
    silverSql: '-- silver: conform raw campaign rows\nselect campaign_id, campaign_name, lower(channel) as channel,\n  lower(product_category) as product_category, customer_segment,\n  budget_eur, start_date, end_date, target_kpi, target_value\nfrom {{ ref("bronze_campaign_master") }}\nwhere budget_eur > 0',
    goldSql: '-- gold: campaign registry (one row per campaign)\nselect *, datediff(end_date, start_date) as run_days\nfrom {{ ref("silver_campaign_master") }}',
  },
  {
    name: 'margin_sales_txn',
    domain: DOMAIN,
    description: 'Order-level margin & sales transactions attributed to campaigns — GMV, discount, NMV, COGS and gross margin per order, with a new-customer flag. Source for margin and sales analysis.',
    columns: [
      { name: 'order_id', description: 'Unique order identifier (grain).' },
      { name: 'campaign_id', description: 'Attributed campaign.' },
      { name: 'order_date', description: 'Order date.' },
      { name: 'country', description: 'Ship-to country (DE/AT/CH/NL/BE).' },
      { name: 'gmv_eur', description: 'Gross merchandise value in EUR (pre-discount).' },
      { name: 'discount_eur', description: 'Discount applied in EUR.' },
      { name: 'nmv_eur', description: 'Net merchandise value in EUR (GMV − discount).' },
      { name: 'cogs_eur', description: 'Cost of goods sold in EUR.' },
      { name: 'gross_margin_eur', description: 'Gross margin in EUR (NMV − COGS).' },
      { name: 'is_new_customer', description: '1 if the order is from a first-time customer, else 0.' },
    ],
    silverSql: '-- silver: clean order-level facts\nselect order_id, campaign_id, order_date, upper(country) as country,\n  gmv_eur, discount_eur, nmv_eur, cogs_eur, gross_margin_eur, is_new_customer\nfrom {{ ref("bronze_margin_sales_txn") }}\nwhere nmv_eur >= 0',
    goldSql: '-- gold: order-level margin base for campaign analysis\nselect *, (gross_margin_eur / nullif(nmv_eur,0)) as margin_rate\nfrom {{ ref("silver_margin_sales_txn") }}',
  },
  {
    name: 'customers',
    domain: DOMAIN,
    description: 'Customer master — signup, country, segment, lifetime orders and NMV, last order date and the acquisition campaign. Used to derive new vs. existing customer economics.',
    columns: [
      { name: 'customer_id', description: 'Unique customer identifier (grain).' },
      { name: 'signup_date', description: 'Account signup date.' },
      { name: 'country', description: 'Customer country.' },
      { name: 'segment', description: 'Segment (new, existing_active, existing_lapsed).' },
      { name: 'lifetime_orders', description: 'Total lifetime orders.' },
      { name: 'lifetime_nmv_eur', description: 'Total lifetime NMV in EUR.' },
      { name: 'last_order_date', description: 'Most recent order date.' },
      { name: 'acquisition_campaign_id', description: 'Campaign that acquired the customer.' },
    ],
    silverSql: '-- silver: conform customers\nselect customer_id, signup_date, upper(country) as country, segment,\n  lifetime_orders, lifetime_nmv_eur, last_order_date, acquisition_campaign_id\nfrom {{ ref("bronze_customers") }}',
    goldSql: '-- gold: customer base with recency\nselect *, datediff(current_date, last_order_date) as recency_days\nfrom {{ ref("silver_customers") }}',
  },
  {
    name: 'cac_cos',
    domain: DOMAIN,
    description: 'Monthly customer-acquisition-cost (CAC) and cost-of-sales (COS%) per campaign, with spend, new customers and revenue. The primary efficiency signal for the budget next-best-action.',
    columns: [
      { name: 'campaign_id', description: 'Campaign.' },
      { name: 'period_month', description: 'Reporting month (YYYY-MM).' },
      { name: 'spend_eur', description: 'Media spend in the month (EUR).' },
      { name: 'new_customers', description: 'New customers acquired in the month.' },
      { name: 'cac_eur', description: 'Customer acquisition cost = spend / new_customers (EUR).' },
      { name: 'revenue_eur', description: 'Revenue attributed in the month (EUR).' },
      { name: 'cos_pct', description: 'Cost of sales = spend / revenue (%).' },
    ],
    silverSql: '-- silver: conform monthly efficiency\nselect campaign_id, period_month, spend_eur, new_customers, cac_eur, revenue_eur, cos_pct\nfrom {{ ref("bronze_cac_cos") }}',
    goldSql: '-- gold: monthly CAC/COS efficiency mart\nselect *, (spend_eur / nullif(new_customers,0)) as cac_check\nfrom {{ ref("silver_cac_cos") }}',
  },
];

// ------------------------------------------- the ACTUAL ROWS as Files (b) ------
// These CSV Files hold the real, readable numbers so participants' agents get data
// TODAY (no live Trino/Cube mart required). Promoted domain-Shared in `agentic-leader-q3-2026`.
export const DATA_FILES = [
  {
    name: 'campaign_master.csv', folder: 'campaign-data', tags: ['campaign', 'master', 'data'],
    description: 'Row data for the campaign_master dataset — 10 Northpeak Unlimited campaigns.',
    text: toCsv(
      ['campaign_id', 'campaign_name', 'channel', 'product_category', 'customer_segment', 'content_theme', 'budget_eur', 'start_date', 'end_date', 'target_kpi', 'target_value'],
      CAMPAIGNS,
    ),
  },
  {
    name: 'margin_sales_txn.csv', folder: 'campaign-data', tags: ['margin', 'sales', 'data'],
    description: `Row data for margin_sales_txn — ${TRANSACTIONS.length} order-level margin/sales transactions.`,
    text: toCsv(
      ['order_id', 'campaign_id', 'order_date', 'country', 'gmv_eur', 'discount_eur', 'nmv_eur', 'cogs_eur', 'gross_margin_eur', 'is_new_customer'],
      TRANSACTIONS,
    ),
  },
  {
    name: 'customers.csv', folder: 'campaign-data', tags: ['customers', 'data'],
    description: `Row data for the customers dataset — ${CUSTOMERS.length} customers.`,
    text: toCsv(
      ['customer_id', 'signup_date', 'country', 'segment', 'lifetime_orders', 'lifetime_nmv_eur', 'last_order_date', 'acquisition_campaign_id'],
      CUSTOMERS,
    ),
  },
  {
    name: 'cac_cos.csv', folder: 'campaign-data', tags: ['cac', 'cos', 'data'],
    description: 'Row data for cac_cos — monthly CAC and COS% per campaign.',
    text: toCsv(
      ['campaign_id', 'period_month', 'spend_eur', 'new_customers', 'cac_eur', 'revenue_eur', 'cos_pct'],
      CAC_COS,
    ),
  },
];

// ------------------------------------------------------- sample-campaign Files --
export const SAMPLE_FILES = [
  {
    name: 'sample-campaign-spring-home-de.md', folder: 'campaigns', tags: ['campaign', 'brief', 'sample'],
    description: 'Sample campaign brief — Spring Home Refresh DE (CMP-1001), incl. a 4-week performance snapshot.',
    text: [
      '# Campaign Brief — Spring Home Refresh DE (CMP-1001)',
      '',
      '- **Objective:** re-activate lapsed home-category customers in Germany.',
      '- **Channel:** paid_social  •  **Segment:** existing_lapsed  •  **Category:** home',
      '- **Budget:** €45,000  •  **Window:** 2026-03-01 → 2026-04-15',
      '- **Primary KPI:** new_customers (target 900)',
      '',
      '## 4-week performance snapshot',
      '| Week | Spend € | New customers | Revenue € | COS % | CAC € |',
      '| --- | --- | --- | --- | --- | --- |',
      '| W1 | 11,250 | 150 | 52,000 | 21.6 | 75.0 |',
      '| W2 | 11,250 | 165 | 56,000 | 20.1 | 68.2 |',
      '| W3 | 11,250 | 160 | 54,000 | 20.8 | 70.3 |',
      '| W4 | 11,250 | 155 | 54,000 | 20.8 | 72.6 |',
      '',
      'CAC is trending down and COS is near the ~20% guardrail. A borderline HOLD — ',
      'watch one more cycle before changing budget.',
    ].join('\n'),
  },
  {
    name: 'sample-campaign-back-to-school-nl.md', folder: 'campaigns', tags: ['campaign', 'brief', 'sample'],
    description: 'Sample campaign brief — Back-to-School Electronics NL (CMP-1002), a search-led new-customer acquisition play.',
    text: [
      '# Campaign Brief — Back-to-School Electronics NL (CMP-1002)',
      '',
      '- **Objective:** acquire new customers in electronics ahead of the school season.',
      '- **Channel:** search  •  **Segment:** new  •  **Category:** electronics',
      '- **Budget:** €60,000  •  **Window:** 2026-08-01 → 2026-09-15',
      '- **Primary KPI:** nmv_eur (target 380,000)',
      '',
      '## Efficiency to date',
      'Blended CAC ≈ €48–49, COS ≈ 15% — comfortably inside the electronics guardrail',
      '(COS target 16%). Margin is positive and new-customer volume is strong.',
      '',
      'Signal: a clear **INCREASE** candidate — headroom exists to scale spend while',
      'efficiency holds. Cap the change at the per-cycle guardrail (≤ +20%).',
    ].join('\n'),
  },
  {
    name: 'sample-campaign-performance-daily.csv', folder: 'campaigns', tags: ['campaign', 'performance', 'sample'],
    description: 'Per-day spend / GMV / NMV / new-customers export for CMP-1002 — a small file an agent can point at directly.',
    text: toCsv(
      ['campaign_id', 'date', 'spend_eur', 'gmv_eur', 'nmv_eur', 'new_customers'],
      Array.from({ length: 14 }, (_, i) => {
        const day = String(i + 1).padStart(2, '0');
        return {
          campaign_id: 'CMP-1002',
          date: `2026-08-${day}`,
          spend_eur: 2000,
          gmv_eur: round2(12000 + rnd() * 4000),
          nmv_eur: round2(10500 + rnd() * 3500),
          new_customers: 38 + Math.floor(rnd() * 12),
        };
      }),
    ),
  },
];

// -------------------------------------------------------- 3 knowledge MDs -------
// Each is authored as a governed workflow (published Shared to `agentic-leader-q3-2026` + indexed)
// AND pushed to the RAG doc index so participants' agents can retrieve the prose.
export const KNOWLEDGE = [
  {
    key: 'context',
    title: 'Campaign Optimization Context',
    md: [
      '---',
      'id: campaign-optimization-context',
      'title: Campaign Optimization Context',
      `domain: ${DOMAIN}`,
      'visibility: Personal',
      'status: draft',
      'version: "1"',
      'rules:',
      '  - {id: g1, text: "GMV is pre-discount; NMV = GMV − discount and is the revenue base for margin", hard: true, scope: workflow}',
      '  - {id: g2, text: "A new customer is derived from is_new_customer=1 on the first attributed order", hard: false, scope: workflow}',
      '---',
      '',
      '```step',
      'id: business-context',
      'title: Northpeak Unlimited — business context',
      'actor: Human',
      'actor_name: Instructor',
      'outputs: [Shared understanding of the campaign-optimization problem]',
      '```',
      '',
      '> tacit: Northpeak Unlimited is a mid-sized European omnichannel retailer (home,',
      '> tacit: lifestyle, consumer electronics, small appliances) across DE/AT/CH/NL/BE.',
      '> tacit: After 5 years of fast growth, growth has slowed and profitability is under',
      '> tacit: pressure: high return rates, rising customer-service cost, and promotional',
      '> tacit: campaigns becoming less efficient. Data is fragmented across systems, so it',
      '> tacit: is not consistently available at the moment of decision. The big bet is to',
      '> tacit: optimize campaign budgets: read each campaign\'s performance, margin/sales,',
      '> tacit: customers and CAC/COS together, then recommend a next-best-action.',
      '> tacit: KPI glossary — GMV: gross merchandise value (pre-discount). NMV: net',
      '> tacit: merchandise value (GMV − discount), the base for gross margin. Gross margin:',
      '> tacit: NMV − COGS. CAC: spend / new customers. COS%: spend / revenue.',
    ].join('\n'),
    docText:
      'Northpeak Unlimited campaign-optimization context. A mid-sized European omnichannel retailer (home, lifestyle, electronics, small appliances) across DE/AT/CH/NL/BE. Growth has slowed; profitability is pressured by high returns, rising service cost and decaying promo efficiency. KPI glossary: GMV = gross merchandise value (pre-discount); NMV = GMV − discount (revenue base for margin); gross margin = NMV − COGS; CAC = spend / new customers; COS% = spend / revenue. New customers are derived from is_new_customer=1 on the first attributed order.',
  },
  {
    key: 'rules',
    title: 'Campaign Optimization Rules',
    md: [
      '---',
      'id: campaign-optimization-rules',
      'title: Campaign Optimization Rules',
      `domain: ${DOMAIN}`,
      'visibility: Personal',
      'status: draft',
      'version: "1"',
      'rules:',
      '  - {id: r_increase, text: "INCREASE budget when COS% < target AND CAC <= segment ceiling AND gross margin positive", hard: false, scope: workflow}',
      '  - {id: r_cut, text: "CUT budget when CAC > segment ceiling OR NMV < spend over the evaluation window", hard: false, scope: workflow}',
      '  - {id: r_hold, text: "HOLD when signals are mixed or within guardrails", hard: false, scope: workflow}',
      '  - {id: r_cap, text: "Never change a budget by more than +/-20% per cycle (guardrail)", hard: true, scope: workflow}',
      '  - {id: r_window, text: "Evaluate over at least a 14-day window and a minimum spend before judging", hard: true, scope: workflow}',
      '  - {id: r_floor, text: "Respect the category margin floor; do not scale a campaign with negative gross margin", hard: true, scope: workflow}',
      '---',
      '',
      '```step',
      'id: decision-rules',
      'title: Budget next-best-action decision rules',
      'actor: Agent',
      'actor_name: Recommendation Agent',
      'inputs: [Campaign performance, Margin & sales, CAC/COS]',
      'outputs: [INCREASE | CUT | HOLD + days + reasoning]',
      '```',
      '',
      '> tacit: Segment CAC ceilings (rules of thumb): new ~= €60, existing_active ~= €90,',
      '> tacit: existing_lapsed ~= €80. COS targets come from campaign_master.target_value',
      '> tacit: when target_kpi = cos_pct, otherwise use ~20% as the house default. Always',
      '> tacit: state the action, the number of days to apply it, and the evidence used.',
    ].join('\n'),
    docText:
      'Campaign optimization decision rules. INCREASE budget when COS% < target AND CAC <= segment ceiling AND gross margin positive. CUT when CAC > segment ceiling OR NMV < spend over the window. HOLD when mixed or within guardrails. Guardrails: max +/-20% budget change per cycle; evaluate over >=14 days with a minimum spend; respect the category margin floor (never scale a negative-margin campaign). Segment CAC ceilings: new ~= 60 EUR, existing_active ~= 90 EUR, existing_lapsed ~= 80 EUR. COS target = campaign_master.target_value when target_kpi=cos_pct else ~20%. Output must state action, days to apply, and reasoning.',
  },
  {
    key: 'workflow',
    title: 'Campaign Optimization Workflow',
    md: [
      '---',
      'id: campaign-optimization-workflow',
      'title: Campaign Optimization Workflow',
      `domain: ${DOMAIN}`,
      'visibility: Personal',
      'status: draft',
      'version: "1"',
      'rules:',
      '  - {id: w1, text: "Always run the recommendation through the Campaign Evaluation Agent before finalizing", hard: false, scope: workflow}',
      '---',
      '',
      '```step',
      'id: ingest',
      'title: Ingest the four data sources',
      'actor: Agent',
      'actor_name: Performance Analysis Agent',
      'inputs: [campaign_master, margin_sales_txn, customers, cac_cos]',
      'outputs: [Joined campaign view]',
      'links:',
      '  - {type: data, ref: "agentic-leader-q3-2026.campaign_master", label: Campaign Master}',
      '  - {type: data, ref: "agentic-leader-q3-2026.cac_cos", label: CAC/COS}',
      '```',
      '',
      '```step',
      'id: analyze-performance',
      'title: Analyze existing-campaign performance',
      'actor: Agent',
      'actor_name: Performance Analysis Agent',
      'outputs: [Per-campaign KPI vs target]',
      '```',
      '',
      '```step',
      'id: analyze-margin',
      'title: Analyze margin & sales',
      'actor: Agent',
      'actor_name: Margin Analysis Agent',
      'outputs: [Gross margin + new-customer economics]',
      '```',
      '',
      '```step',
      'id: evaluate',
      'title: Evaluate campaigns',
      'actor: Agent',
      'actor_name: Evaluation Agent',
      'outputs: [Rule-checked assessment]',
      '```',
      '',
      '```step',
      'id: recommend',
      'title: Recommend the next-best-action',
      'actor: Agent',
      'actor_name: Recommendation Agent',
      'outputs: [INCREASE | CUT | HOLD budget for X days + reasoning]',
      '```',
      '',
      '> tacit: After recommending, run your output through the shared Campaign Evaluation',
      '> tacit: Agent, read the rubric feedback, rework, and re-run. Then show the results',
      '> tacit: in your Campaign App.',
    ].join('\n'),
    docText:
      'Campaign optimization end-to-end workflow: (1) ingest campaign_master, margin_sales_txn, customers, cac_cos; (2) analyze existing-campaign performance (KPI vs target); (3) analyze margin & sales (gross margin + new-customer economics); (4) evaluate campaigns against the rules; (5) recommend a next-best-action (INCREASE/CUT/HOLD budget for X days + reasoning); (6) run the recommendation through the Campaign Evaluation Agent, rework on feedback, then show results in a Campaign App.',
  },
];

// ---------------------------------------------------- Campaign Evaluation Agent --
// Authored + built by the instructor, then promoted Shared to `agentic-leader-q3-2026`. Thanks to
// the run-scope change (getSystemForRun), any Creator in `agentic-leader-q3-2026` can RUN it but
// none can edit/rebuild it.
export const EVAL_AGENT = {
  name: 'Campaign Evaluation Agent',
  domain: DOMAIN,
  entrypoint: 'evaluator',
  grantTools: ['knowledge_search', 'metrics_query', 'retrieve'],
  // Resolved to real ids by the seed at run time.
  grantData: ['campaign_master', 'margin_sales_txn', 'cac_cos'],
  // Keys into KNOWLEDGE[] — the seed resolves these to runtime workflow ids.
  grantKnowledge: ['context', 'rules', 'workflow'],
  agent: {
    id: 'evaluator',
    role: 'Evaluate participant campaign-budget recommendations against the rubric',
    agent_md: [
      '# Campaign Evaluation Agent',
      '',
      'You score a participant\'s campaign-budget recommendation. You are read-only:',
      'you never change budgets — you assess the quality of a recommendation.',
      '',
      '## Rubric (score each 0–5, then an overall verdict)',
      '1. **Rule adherence** — does the action follow the INCREASE/CUT/HOLD rules and',
      '   respect the +/-20% per-cycle cap, the >=14-day window and the margin floor?',
      '2. **Margin safety** — is gross margin positive and is COS% within the target?',
      '3. **Evidence use** — are CAC, COS%, NMV and new-customer numbers cited from the',
      '   data (campaign_master, margin_sales_txn, cac_cos), not asserted?',
      '4. **NBA validity** — is the output a concrete action (INCREASE/CUT/HOLD),',
      '   a number of days, and a clear reason?',
      '',
      '## Output',
      'Return the four sub-scores, an overall PASS/REWORK verdict, and 1–3 specific,',
      'actionable fixes. Reference the campaign_id you evaluated.',
    ].join('\n'),
  },
};

// ------------------------------------------------------------- Campaign App -----
export const CAMPAIGN_APP = {
  name: 'Campaign Optimization',
  template: 'dashboard',
  domain: DOMAIN,
  description:
    'Reference Campaign App — a dashboard template to show campaign performance, ' +
    'margin/CAC/COS and the recommended next-best-action. Participants build their ' +
    'own; this shared copy is the worked example.',
};
