<!-- SPDX-License-Identifier: Apache-2.0 -->
# Northpeak — e-commerce case-study seed

A coherent fictional online store (**Northpeak**, an outdoor & apparel retailer)
seeded into a live Sovereign Agentic OS as **real artifacts created through the
platform's own governed flows** — not fixtures, not DB inserts. One story threads
every tab: the dashboard uses a metric, the metric uses the Gold mart, the Gold
mart uses the ingested orders; the *Reduce churn* bet bundles the churn model + the
Customer Health dashboard under the Retention pillar.

## Mechanism

- **Identity (governed, no human admin password).** The cast are operator-seeded
  demo users supplied via `OS_USERS` (`charts/.../values osUI.usersSeed`). On
  ingest `lib/users.ts` hashes their passwords (scrypt) and marks them
  email-verified, so they are full governed identities. The seed **logs in as
  them** (`POST /api/auth/login`) and reuses the signed `soa_session` cookie — the
  exact path a browser uses. Every downstream call is therefore subject to the
  same role checks, OPA/RLS and audit. No governance is bypassed.
- **Create flows.** The seed drives each tab's real create / promote / certify /
  run endpoint (see the map below). Separation-of-duties is honoured: a Creator
  builds and *requests* promotion; a Builder approves it in Governance (an
  approval *is* the action); an Admin certifies to the marketplace.
- **In-cluster run.** A `batch/v1` Job runs the script with `node:22-alpine`,
  reaching the `os-ui` Service over the cluster network. It touches only the
  governed API — never the Kubernetes API, Helm, or a backend directly.

## The cast (governed demo identities)

| id | role | domains |
| --- | --- | --- |
| `nova-admin` | admin | platform, sales, marketing, ops |
| `sasha-sales` | builder | sales |
| `morgan-mktg` | builder | marketing |
| `omar-ops` | builder | ops |
| `riley-sales` | creator | sales |
| `kai-mktg` | creator | marketing |
| `devi-ops` | creator | ops |

`users.example.json` shows the shape. **Passwords are never committed** —
`gen-credentials.mjs` generates them into two gitignored files:
`users.secret.json` (the seed's `SEED_CREDENTIALS`) and `os-users.seed.json`
(the `OS_USERS` / `osUI.usersSeed` value).

## Run recipe

### Prerequisites (live cluster)
The governed routes degrade to an honest in-process mock when a backend is
absent, so the seed always *runs*; for each artifact to be fully *live* these
should be up:

| Capability | Needs |
| --- | --- |
| Metrics resolve / explore | Cube (`cube`) reading the Trino Gold mart |
| Dashboards render | Superset |
| Agents execute tool calls live | LiteLLM → model-server + `agent-runtime` |
| Science train / predict | `science.ml.enabled=true` (per domain) + ml-agent / MLflow / KServe |
| Knowledge / Files indexing | OpenSearch (+ Docling/transcribe for Files) |
| Connections to external hosts | egress proxy + Admin-approved egress allowlist |

### 1. Generate credentials + wire the cast
```bash
node seed/ecommerce/gen-credentials.mjs
# → users.secret.json, os-users.seed.json  (both gitignored)
```
Put the `os-users.seed.json` array into the live values as `osUI.usersSeed`
(or `OS_USERS`) and redeploy os-ui so the identities exist.

### 2. Run in-cluster (the orchestrator runs this on prod)
```bash
NS=agentic-os
kubectl -n $NS create configmap northpeak-seed \
  --from-file=seed.mjs=seed/ecommerce/seed.mjs \
  --from-file=client.mjs=seed/ecommerce/lib/client.mjs \
  --from-file=narrative.mjs=seed/ecommerce/lib/narrative.mjs
kubectl -n $NS create secret generic northpeak-seed-credentials \
  --from-file=SEED_CREDENTIALS=seed/ecommerce/users.secret.json
kubectl -n $NS apply -f seed/ecommerce/k8s/job.yaml
kubectl -n $NS logs -f job/northpeak-seed
```

### Local (kind) — author/test loop used to build this
```bash
# point at a port-forwarded os-ui (with OS_USERS + OS_SESSION_SECRET set on it)
OS_UI_URL=http://localhost:3000 \
SEED_CREDENTIALS="$(cat seed/ecommerce/users.secret.json)" \
node seed/ecommerce/seed.mjs
```

The seed is **idempotent**: it reuses an artifact when one of the same name
exists and recovers from "already defined / already promoted" on a re-run.

## Run order → tab → governed endpoint → artifact

| # | Phase / actor | Endpoint(s) | Artifact |
| --- | --- | --- | --- |
| 0 | **Users** — all cast | `POST /api/auth/login` | governed sessions |
| 1 | **Connections** — Builders + Admin | `POST /api/egress` → `POST /api/egress/{id}/approve` → `POST /api/connections` → `/{id}/test` → `/{id}/promote` | `northpeak-orders-db` (Postgres), `northpeak-drive`, `northpeak-support-mcp` |
| 2 | **Files** — Creators | `POST /api/files` | product catalog, return-policy, support transcript (ingested + indexed) |
| 3 | **Data** — Creator + Builder | `POST /api/data/datasets` → `/{id}/version` ×3 → `/{id}/docs` → `/{id}/build` → `/{id}/promote` → `POST /api/governance/approvals` | `northpeak-commerce` Bronze→Silver→**Gold** (revenue + churn base), promoted to a governed **asset** |
| 4 | **Metrics** — Creator/Builder/Admin | `POST /api/metrics/define` ×4 → `/explore` → `/govern` | Revenue, AOV, Conversion, ChurnRate; Revenue **certified** to marketplace |
| 5 | **Dashboards** — Builder + Admin | `POST /api/dashboards/build` ×2 → `/govern` | Sales Overview, Customer Health; Sales Overview **certified** to marketplace |
| 6 | **Knowledge** — Creator + Builder | `POST /api/knowledge/workflows` → `/{id}/tacit` → `/{id}/publish` ; `POST /api/knowledge/docs` | "Handle a return", "Fraud check" workflows (+ tacit notes) |
| 7 | **Agents** — Builders | `POST /api/agents/systems` → `PUT /{id}/files` (system.yaml) → `/{id}/build` → `/{id}/run` | Support, Fraud, Pricing agents — **built + run** through the governed gateway |
| 8 | **Science** — Builder + Admin | `POST /api/science/model` (promote / go-live / certify / retrain) → `POST /api/science/predict` | churn model → Domain → Production → Marketplace; **predict** returns a score |
| 9 | **Big Bets** — Admin | `POST /api/big-bets` (Owner + Problem Statement + Solution Idea + value + Planned Go-Live; **name derived** from the statement) → `/{id}/components` | "Reduce churn", "Increase AOV" — each bundling 3 components with `consumes` lineage |
| 10 | **Strategy** — Admin | `POST /api/strategy/pillars` (value metric described) → `PUT /{id}/value-metric` (governed **or** manual) → `POST /{id}/value-entry` (manual months) → `/{id}/bets` → `/{id}/snapshot` | Retention pillar (**governed** value metric) + Growth pillar (**manual** monthly entries); bet links; value rollup + history |

## Proven on kind vs. needs the live run

**Proven locally (production build + standalone server, in-process backends,
`ML_ENABLED=true`): 47/47 steps, 0 failed — and idempotent (a second run is
also 47/47).** Auth, connections (+ egress approval), files ingest, the full
Bronze→Silver→Gold build + governed promotion, all four metrics (define + explore
returns rows), both dashboards (build + marketplace certify), knowledge workflows,
all three agents (build + run, governed path traced), the churn-model lifecycle
(promote / go-live / certify / predict / retrain — executed governed; on a fresh
tenant with no pre-seeded churn model the lifecycle ops return `404` and `predict`
denies, which the run records without error), both big bets created with the
**new shape** (Owner + Problem Statement + Solution Idea + value + Go-Live; name
derived) bundling 3/3 components, and both strategy pillars — **Retention with a
governed value metric, Growth with manual monthly entries** — with value rollup +
history populated.

Needs the live cluster to be *live* rather than honest-mock:
- **Metrics/Dashboards** resolve against the in-process mock locally; Cube +
  Superset make them render real Trino rows on the cluster.
- **Agents** report `mode: offline-mock` locally; with `agent-runtime` + LiteLLM
  reachable, Build/Run execute the real LangGraph and every tool call is
  OPA-checked + Langfuse-traced.
- **Knowledge docs** ingest needs OpenSearch (locally returns 502; the workflow
  index path still works). Files indexing similarly upgrades with OpenSearch +
  Docling/transcribe.
- **Science** requires `science.ml.enabled=true` (set per domain by an Admin).

## Known platform seams (honest notes)

- **Big Bets registry** is an in-process mock of the future Supabase store, so
  components are added via its governed *scaffold* flow (which records a real
  `consumes` edge to the upstream artifact id) rather than by linking the exact
  runtime artifact id. The bundled value still rolls up.
- **Strategy ↔ Big Bet** linking currently accepts the platform's stub-catalogue
  bet ids (the bets-bridge seam); the seed links the matching stub
  (`seed_bet_reduce_churn`, `seed_bet_winback`) so the wired rollup is shown,
  while the real Big Bet stands on its own with its bundled components.

## Platform fixes shipped with this seed

- **Governance effect (earlier).** The governance effect for an approved
  `dataset_promote` / `dataset_certify` never moved the dataset tier (the
  offline-safe `applyApprovedPromotion()` / `certify()` had **no callers**),
  which permanently blocked metric definition through the governed promote path.
  The effect handler (`os-ui/lib/governance/effects.ts`) now executes those store
  functions — an approval truly applies the tier move, offline and live.
- **Science drift null-deref (this pass).** Re-verifying the seed against the
  reworked surfaces surfaced a regression: with `ml.enabled=true`,
  `GET /api/science/model` returned **500** because the monitoring adapter's
  `drift()` dereferenced the *latest* point of a now-empty fresh-tenant drift
  series (`os-ui/lib/science/adapters.ts`). It now reports an honest empty state
  (`retrainDue=false`, `latestPsi/Auc=0`) instead of crashing — so the Science
  tab + the seed's Science phase work when ML is enabled. (Science/Big-Bets/
  Strategy unit tests — 67 — still pass.)
