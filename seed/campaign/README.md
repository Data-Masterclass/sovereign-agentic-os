<!-- SPDX-License-Identifier: Apache-2.0 -->
# Campaign-Optimization Big Bet — "Northpeak Unlimited" seed

The Phase-3 exercise material for the course: a fictional mid-sized European
omnichannel retailer (**Northpeak Unlimited** — home, lifestyle, consumer
electronics, small appliances across DE/AT/CH/NL/BE). Seeded into a live Sovereign
Agentic OS as **real, governed artifacts** in a single shared `cohort` domain, so
**33 participants** can DO the Big Bet: build agents that read campaign performance,
margin/sales, customers and CAC/COS, then recommend a budget **next-best-action**
(INCREASE / CUT / HOLD budget for X days + reasoning), run it through the shared
**Campaign Evaluation Agent**, rework, and show results in a **Campaign App**.

This is a **separate narrative** from the e-commerce (outdoor-retailer) seed. It only
reuses that module's zero-dependency governed-API client (`../ecommerce/lib/client.mjs`)
unchanged.

## The cohort cast (governed identities)

Each user signs in **by email** (the login label); `id` is the internal principal.
Passwords are **never committed** — `gen-credentials.mjs` generates them into two
gitignored files.

| id | email (sign-in) | role | domains |
| --- | --- | --- | --- |
| `cohort-instructor` | instructor@cohort.datamasterclass.com | builder | cohort |
| `participant01` … `participant33` | participantNN@cohort.datamasterclass.com | creator | cohort |

The **instructor** (a Builder in `cohort`) authors and shares every material.
**Participants** are Creators: they consume the shared materials and build their
**own** agents/apps in personal space. Creators cannot promote/publish/certify —
exactly the required lockdown (Personal + Domain-Shared only, no marketplace).

## What it seeds (all in the `cohort` domain)

| Tab | Artifact(s) | Governed path |
| --- | --- | --- |
| **Data** | 4 datasets — `campaign_master`, `margin_sales_txn`, `customers`, `cac_cos` (Bronze→Silver→Gold + column docs), each **promoted to a domain asset** | `POST /api/data/datasets` → `/version`×3 → `/docs` → `/build` → `/promote` → `POST /api/governance/approvals` |
| **Files** | The **actual rows** as 4 CSV files + 3 sample-campaign files (2 briefs + a per-day export), each **promoted domain-Shared** | `POST /api/files` → `PATCH /api/files/{id}` (docs) → `/promote` → approve |
| **Knowledge** | 3 MDs — context / rules / workflow, **published Shared + RAG-indexed** | `POST /api/knowledge/workflows` → `PATCH` (workflow.md) → `/publish` → `/index`; `POST /api/knowledge/docs` |
| **Agents** | 1 **Campaign Evaluation Agent** (grants the shared datasets + knowledge + tools), **promoted Shared** — every participant can RUN it, none can edit it | `POST /api/agents/systems` → `PUT /{id}/files` → `/build` → `/promote` |
| **Software** | 1 reference **Campaign App** (dashboard template), **promoted Shared** | `POST /api/apps` → `/{id}/promote` |

**Data seeded BOTH ways (locked decision #4):** the 4 governed *datasets* carry the
catalog / lineage / column-docs and are grantable to agents; the 4 *CSV files* carry
the **actual, readable rows** so participants' agents get real numbers **today**
without a live Trino/Cube mart. The CSV path is the guaranteed working one — a
participant can `GET /api/files/{id}` and read the rows.

## Run recipe

### 1. Generate credentials + wire the cast
```bash
node seed/campaign/gen-credentials.mjs
# → seed/campaign/users.secret.json  (SEED_CREDENTIALS for the Job)
# → seed/campaign/os-users.seed.json (merge into osUI.usersSeed / OS_USERS)
```
Merge the `os-users.seed.json` array **into** the existing `osUI.usersSeed` JSON
array in values (append the 34 rows; keep the existing Northpeak/admin rows), then
redeploy os-ui so the identities exist. Every row carries a valid `email` — the
identity store **skips** a seed row with no usable email, so the email field is
required.

### 2. Run in-cluster (the orchestrator runs this on prod)
```bash
NS=agentic-os
kubectl -n $NS create configmap northpeak-campaign-seed \
  --from-file=seed.mjs=seed/campaign/seed.mjs \
  --from-file=narrative.mjs=seed/campaign/narrative.mjs \
  --from-file=client.mjs=seed/ecommerce/lib/client.mjs
kubectl -n $NS create secret generic northpeak-campaign-credentials \
  --from-file=SEED_CREDENTIALS=seed/campaign/users.secret.json
kubectl -n $NS apply -f seed/campaign/k8s/job.yaml
kubectl -n $NS logs -f job/northpeak-campaign-seed
```

### Local (kind) — the author/test loop used to build this
```bash
# os-ui started with OS_USERS + OS_SESSION_SECRET set:
OS_UI_URL=http://localhost:3000 \
SEED_CREDENTIALS="$(cat seed/campaign/users.secret.json)" \
node seed/campaign/seed.mjs
```

The seed is **idempotent**: it reuses an artifact when one of the same name exists,
and recovers from "already promoted/published" on a re-run.

## Participant golden path (Phase-4 browser test)

Sign in by email as a participant (e.g. `participant01@cohort.datamasterclass.com`):
1. **Data** → see the 4 domain-Shared datasets (open docs/columns).
2. **Files** → open the 4 CSV data files + the 3 sample-campaign files (the readable rows).
3. **Knowledge** → open the 3 MDs (context / rules / workflow) under "My domain".
4. **Agents** → **New system** (your own): write `system.yaml` granting the shared
   datasets + knowledge + `knowledge_search`/`metrics_query`; author the analysis +
   recommendation agents; **Build**, then **Run** → get an INCREASE/CUT/HOLD + reasoning.
5. **Evaluation** → open the Shared **Campaign Evaluation Agent** and **Run** your
   recommendation through it; read the rubric feedback; rework and re-run. (You can
   RUN it but **cannot** edit/rebuild it.)
6. **Software** → create your **own** Campaign App (dashboard template); the shared
   "Campaign Optimization" app is the reference/worked example.
7. Governance check: trying **Promote/Publish/Certify** on any artifact → **403**.

## Proven on kind vs. needs the live cluster

**Proven locally (production `next build` + standalone `next start`, in-process
backends, seeded via `OS_USERS`): 51/51 steps ok, 0 failed — and idempotent (a
second run is also 51/51).** All 34 identities authenticate; 4 datasets build +
promote; 7 files ingest + promote to domain assets (a peer participant reads their
rows); 3 knowledge workflows publish Shared + index; the eval agent builds + promotes
Shared and **a participant Creator RUNs it (HTTP 200)** while a WRITE/PROMOTE is
denied (403); the Campaign App promotes Shared.

Needs the live cluster to be *live* rather than honest-mock:
- **Agents** report `mode: offline-mock` locally; with `agent-runtime` + LiteLLM
  reachable, Build/Run execute the real LangGraph and every tool call is
  OPA-checked + Langfuse-traced.
- **Knowledge docs** RAG ingest (`POST /api/knowledge/docs`) needs OpenSearch
  (locally returns `502`); the governed workflow index path still succeeds, and the
  3 MDs are published Shared regardless.
- **Metrics / Cube / DuckDB numbers** on the datasets need a physical `gold_campaign_*`
  Iceberg mart (deferred). As governed datasets the catalog/lineage/agent-grants are
  real; the **CSV files are the working data path** for agents today.

## Platform fix shipped with this seed

- **`file_promote` governance effect was a no-op.** Approving a file promotion only
  logged "cleared held action (mock)" — it never moved the file to a domain asset, so
  a shared file stayed private and invisible to the domain (the same class of bug the
  e-commerce seed fixed for `dataset_promote`). The effect handler
  (`os-ui/lib/governance/effects.ts`) now calls `applyApprovedFilePromotion`, so an
  approved promotion truly shares the file to its domain (offline + live). Covered by
  a new `effects.test.ts` case.
- **Run-scope for domain-Shared agents.** A domain-Shared agent system could not be
  *run* by a non-owner (Run was edit-scoped). Added `getSystemForRun`
  (`os-ui/lib/agents/store.ts`) — view-scope + role ≥ Creator in the system's domain —
  and switched the Run route to it (file writes + Build stay edit-scoped). A
  participant can now RUN the shared Campaign Evaluation Agent but never edit it.
  Covered by new `store.test.ts` cases.
