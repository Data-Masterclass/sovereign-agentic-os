<!-- SPDX-License-Identifier: Apache-2.0 -->
# Northpeak — cohort DATA seed (Data · Metrics · Dashboards)

Populates the live tenant with the **Northpeak** e-commerce case study the cohort
exercises consume: six governed datasets (physical bronze/silver/gold Iceberg
tables), 19 Cube metrics and 3 Superset dashboards — all created **through the
platform's own governed paths**, never a DB insert or a direct Trino session.

It builds AROUND and ON TOP of the one mart that already exists
(`iceberg.sales.gold_northpeak_commerce`, 150,000 sessions from
`northpeak-marts-init`): every downstream number is arithmetically derived from it,
and the two synthetic sources (returns, campaigns) are generated deterministically
in SQL, so re-runs are byte-stable.

## ⚠ Sequencing gates

1. **Polaris ≥ 1.1.0 first.** On 1.0.1 every new-table create fails (virtual-host
   S3 bug) — and this seed is almost entirely new-table CTAS. `marts.mjs` opens
   with a fail-fast write probe (CTAS → count → drop) so a premature run aborts
   cleanly before touching anything.
2. **Data W5 ("publish→physical", T8) is not a dependency** — this seed
   materializes the asset FQNs itself through the same governed `/execute` path T8
   will use. If W5 lands first, its promote-approval effect may attempt a CTAS
   from a personal-lane gold this seed never created; the effect must skip when
   `assetTarget()` is already queryable — verify on the live run.

## The case study

| Dataset (domain `northpeak`) | grain / rows | key gold columns | metrics |
| --- | --- | --- | --- |
| Northpeak Web Sessions | session / 150k | region, product, session_month, converted, net_amount | sessions, conversion_rate, demand |
| Northpeak Orders | order / ≈4.8k | campaign_id, order_month, net_amount, discount_amount | revenue, orders, aov, discounts |
| Northpeak Customers | customer / 4.2k | segment (loyal/active/browser), lifetime_revenue, churn_flag (≈18%) | customers, churn_rate, lifetime_value |
| Northpeak Returns | return / ≈575 | return_reason, return_month, refund_amount (≈12% of orders) | returns, refund_total, avg_refund |
| Northpeak Campaigns | campaign×month / 36 | channel, spend_eur, attributed_revenue, roas (1.2–5.7×) | spend, attributed_revenue, roas |
| Northpeak Returns Impact | region×product×month / 30 | net_revenue_after_returns, return_rate — the Gold-JOIN worked example | net_revenue_after_returns, return_rate, refunds |

Dashboards: **Northpeak Executive Overview** (Orders), **Northpeak Returns &
Retention** (Returns Impact), **Northpeak Campaign Performance** (Campaigns) — all
certified to the marketplace.

## Mechanism (two governed layers, one Job)

1. **`marts.mjs` — physical.** Every table is ONE allowlisted
   `CREATE OR REPLACE TABLE iceberg.northpeak.… AS SELECT` through the query-tool
   **`POST /execute`** as `alp-instructor` (builder whose domains include
   `northpeak`): the statement allowlist + target-schema/role floor
   (`images/query-tool/execute_guard.py`) and Trino→OPA on every CTAS read apply
   exactly as for the UI. Verified with governed `POST /query` counts. Idempotent
   (skips when all golds are populated; `MARTS_FORCE=true` rebuilds).
2. **`seed.mjs` — governed API.** Logs in via `POST /api/auth/login` (real session
   cookies, real roles) and drives: dataset registry + version artifacts (the real
   CTAS bodies) + docs → live gold Build report → **promotion** (owner requests,
   `aborek` approves in Governance) → **metrics** (`/api/metrics/define`, the
   convergent form path) → **certification** (Admin → Data Product, trust `gold`,
   visibility `shared`) + certify-stage Build (OPA policy push + OPA==Cube
   conformance) → **lineage** upstream edges (dataset.yaml via the governed file
   surface) → **dashboards** (`/api/dashboards/build` → promote → certify) →
   **verification as one real student** (sees the products, resolves a metric,
   reads rows via `/api/query`, join picker offers the products; promote/certify
   are DENIED).

## Why domain `northpeak` (and how students see it)

Physical schemas must be bare lowercase identifiers — the cohort domain
`agentic-leader-q3-2026` (hyphens) can never be one. The seed therefore lives in
the teaching domain **`northpeak`** (added to `alp-instructor` + `aborek` only)
and reaches the 36 students as **certified marketplace products** (visible +
joinable for every authenticated user), with read grants for:

- `domain: northpeak` (owning domain),
- `domain: agentic-leader-q3-2026` (the cohort → OPA `shared_with`),
- `user: agentic-leader-q3-2026` — a deliberate seam workaround: `/api/query` and
  NL→SQL read as the caller's DOMAIN principal (`u.domains[0]`), which the pushed
  OPA roster does not declare; this grant puts the literal principal string in
  `shared_with_users` so student Query-tab reads work. Platform fix (declare
  domain principals in `compileOpa`) tracked for W5/T8.

Students consume the products and build their OWN work in `iceberg.personal_<uid>`
(the guard allows any authenticated user there) — e.g. re-creating the Returns
Impact join in their personal lane is the stage-4 reuse exercise.

## Offline validation (what is already proven without a cluster)

- `node --test seed/ecommerce-data/marts.test.mjs` — 9 tests: every statement
  passes a mirror of the `/execute` guard for the seed identity, dependency-safe
  ordering, FQN lockstep with `store-fqn.slug()`, docs/measures/dashboards closure,
  the cohort grant set.
- Cross-checked against the REAL `execute_guard.py` (all statements accepted;
  student write + hyphenated-schema writes correctly rejected).
- All statements parse as Trino SQL (sqlglot) AND the full pipeline was executed
  in DuckDB (transpiled) against a formula-identical 150k base mart: conversion
  3.2%, churn 18.0%, returns 12.0%, ROAS 1.2–5.7, attribution lossless
  (Σ attributed_revenue == Σ revenue == €971,032.30).

Pending the live run: actual Trino/Polaris execution (Polaris-gated), Cube model
sync + metric resolution, Superset import, OPA policy push effects.

## Run (orchestrator, on the live tenant)

```bash
# gates on Polaris >= 1.1.0, updates OS_USERS (adds `northpeak` to
# alp-instructor + aborek), composes credentials, runs the Job, tails logs:
bash deploy/apply-data-seed.sh
```

Manual equivalent: see `k8s/job.yaml` header. Local (kind/port-forward):

```bash
QUERY_TOOL_URL=http://localhost:8000 node seed/ecommerce-data/marts.mjs
OS_UI_URL=http://localhost:3000 \
SEED_CREDENTIALS='{"alp-instructor":"…","aborek":"…","<learner>":"…"}' \
node seed/ecommerce-data/seed.mjs
```

Credentials are composed at run time from the gitignored `values.private.yaml` +
`seed/campaign/users.secret.json` — never committed.

## Honest notes

- The base mart correlates region with month (`mod 3` vs `mod 6` share a factor),
  so region×month crosses are degenerate (6 combos). Campaigns are therefore
  grained campaign×month; Returns Impact has 30 (not 90) cells. Documented, not
  hidden.
- `*_id` columns scaffold as Cube `number` dimensions (platform inference in
  `lib/data/metrics.ts inferDimType`) although the data is varchar — pre-existing
  platform behavior (same shape as the original northpeak-commerce cube); the pk
  dimension is excluded from the view includes, so metrics resolve regardless.
- The gold Build / certify Build reports are recorded honestly in the run log —
  a ✗ row (e.g. OpenMetadata absent) does not abort the seed, it is evidence.
