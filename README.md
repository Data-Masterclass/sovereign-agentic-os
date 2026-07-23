# Sovereign Agentic OS — stack (umbrella chart)

The downloadable/installable artifact for the Sovereign Agentic OS: one **umbrella Helm
chart** (`charts/sovereign-agentic-os`) that brings up the platform (**Layers 1–4** + a
secure-by-default baseline) on any Kubernetes cluster — **self-contained and works out of the
box**. Layer 4 (Science/ML) is opt-in and off by default.

Spec lives one level up in `../stackit/`. Decisions there are settled — this repo
implements them.

## Quickstart (one command)

```bash
# prereqs: docker (running), kind, helm, kubectl
kind create cluster --name agentic-os     # or let install.sh create it
./install.sh                               # press Enter through every prompt
```

Pressing Enter through every prompt gives the **fully self-contained** install: every
backend bundled (Postgres/CloudNativePG, OpenSearch, ClickHouse, Valkey, MinIO object
storage) and a tiny local mock LLM — nothing external required. The wizard can instead opt
any backend into a managed/external service (or "all STACKIT managed").

When it finishes, `install.sh` prints the **demo logins**. The default Administrator-style
console login is **Langfuse**: `admin@datamasterclass.com` / `langfuse-local-dev-admin`
(plus Superset `admin` / `superset-admin-local-dev`, LiteLLM `admin` /
`litellm-admin-local-dev`, Forgejo `gitea_admin` / `forgejo-admin-local-dev`, and Argo CD
`admin`). Non-interactive: `./install.sh --defaults`. Remove: `./install.sh --uninstall`.

**Two front doors** (port-forward, then open):
```bash
kubectl -n agentic-os port-forward svc/os-ui 8080:3000           # OS UI — product front door
kubectl -n agentic-os port-forward svc/admin-console 8081:8080   # Admin Console — operate the stack + docs
```

Presets: `values.selfcontained.yaml` (default) · `values.stackit-managed.yaml` (backends →
STACKIT managed) · `values.example.yaml` (the `mode: bundled|external` contract).

> **Deploy to STACKIT (recommended: single node).** To run on STACKIT, follow
> **[`docs/stackit-deployment-guide.md`](docs/stackit-deployment-guide.md)** — the primary,
> verified path: one `g2i.8` node, single AZ, all backends self-contained, pause off-hours
> with `deploy/stackit off`. (Managed-services Mode B and multi-node HA are **known-blocked**:
> cross-node pod networking on SKE-in-an-SNA is broken — single node sidesteps it.)

> **The OS UI** is a **v1.0 front door** — every sidebar tab is a real surface: Home (live
> stack status), Agents, Knowledge, Structured Data, Software (CI), Monitoring, Governance,
> Dashboards, Gateway, Orchestration, Science, Metrics, Unstructured Data, Connections,
> Marketplace, Strategy/Big Bets, Settings, and About/Licenses. Styled to the Sovereign
> Agentic brand. It ships with **real, self-hosted authentication** (scrypt-hashed
> passwords, signed sessions, roles) — see **First-run sign-in** below. A future swap to
> Ory keeps the same `currentUser`/`requireUser` seam.

### First-run sign-in (OS UI)

The OS UI ships with **no real or demo users** — only a secure first-run bootstrap:

1. **Bootstrap.** On the very first run the identity store is empty, so a single default
   admin exists: **`admin` / `admin`**. Open the OS UI and sign in with it.
2. **Forced setup.** You are immediately required to set a **real username + email + a
   strong password** (min 12 chars, mixed character classes; weak passwords are rejected).
   The instant you submit, the `admin/admin` login is **disabled**.
3. **Email verification.** Setup returns a verification link (in a real deploy this is
   emailed; on local-kind it is shown so you can click it). Verifying your email
   **permanently deletes** the bootstrap admin — `admin/admin` is gone for good.
4. **Recovery key.** As an admin, go to **Users → Account recovery** and **Generate a
   master recovery key**. It is shown and downloaded **once**; the server stores only a
   hash. If you are ever locked out, use it at **`/recover`** to reset any account's
   password. **Lose it and it cannot be recovered** — store it offline.

Passwords are never stored in plaintext, never logged, and never returned to the browser.
The session secret is auto-generated into the `os-ui-session` Kubernetes Secret (never the
in-code dev fallback). Operators can pre-provision real users via `osUI.usersSeed` (a JSON
array; plaintext passwords there are hashed on ingest) — but the default ships none.
>
> **Local only.** Real STACKIT provisioning stays gated on the SA key + cost sign-off
> (`../stackit/stackit.md`).

## What's in the agent-core slice

The thinnest end-to-end slice that proves the system works:

| Component | Role | Packaged as |
|---|---|---|
| **LiteLLM** | model / MCP gateway | wrapped upstream chart |
| **Langfuse v3** | observability / tracing | wrapped upstream chart |
| ↳ **CloudNativePG Postgres** | Langfuse metadata DB | operator + `Cluster` CR |
| ↳ **ClickHouse** | Langfuse analytics | bespoke template |
| ↳ **Valkey** (BSD-3, not Redis) | Langfuse queue/cache | bespoke template |
| ↳ **MinIO** (S3 API) | object-storage stand-in for STACKIT Object Storage (local dev only) | bespoke template |
| **OpenSearch** | retrieval backbone (vector + lexical) | wrapped upstream chart |
| **mock-model** | local OpenAI-compatible stub (sovereign/offline) | bespoke template |
| **sample LangGraph agent** | calls LLM via LiteLLM, traced in Langfuse, RAG over OpenSearch | bespoke template |

No pgvector (OpenSearch is the retrieval backbone). MinIO (AGPL) is the local S3 stand-in
only — never bundled/shipped; on STACKIT the real Object Storage endpoint is used. For a full
current overview see **`docs/Sovereign-Agentic-OS-Guide.md`** (the user guide / PDF). No Redis (SSPL) — Valkey.

## Prerequisites

- A container runtime + `docker` CLI (Colima or Docker Desktop)
- `kind`, `helm`, `kubectl`
- ~14 GB / 6 CPU available to the runtime VM (the slice is RAM-bound: OpenSearch +
  ClickHouse + Postgres)

## Run it locally

```bash
# 0. validate the chart (no cluster needed)
helm lint charts/sovereign-agentic-os

# 1. create the local cluster
kind create cluster --name agentic-os

# 2. bootstrap cluster-scoped operators (CloudNativePG) — see scripts/bootstrap-local.sh.
#    Operators ship CRDs + admission webhooks and must exist before the OS chart's
#    CRs are applied (mirrors stackit.md §2).
./scripts/bootstrap-local.sh

# 3. build the two bespoke images and load them into kind
docker build -t sovereign-os/mock-model:0.1.0  images/mock-model
docker build -t sovereign-os/sample-agent:0.1.0 images/sample-agent
kind load docker-image sovereign-os/mock-model:0.1.0 sovereign-os/sample-agent:0.1.0 --name agentic-os

# 4. render + client-validate (CRDs from step 2 must be present)
helm repo add langfuse https://langfuse.github.io/langfuse-k8s
helm repo add opensearch https://opensearch-project.github.io/helm-charts
helm repo add dagster https://dagster-io.github.io/helm
helm repo add open-metadata https://helm.open-metadata.org
helm repo add superset https://apache.github.io/superset
helm repo add argo https://argoproj.github.io/argo-helm
helm repo add jupyterhub https://hub.jupyter.org/helm-chart/
helm dependency build charts/sovereign-agentic-os
helm template agentic-os charts/sovereign-agentic-os -f values.local.yaml \
  | kubectl apply --dry-run=client -f -

# 5. install
helm install agentic-os charts/sovereign-agentic-os \
  -n agentic-os --create-namespace -f values.local.yaml

# 6. watch it come up
kubectl -n agentic-os get pods -w
```

Teardown: `kind delete cluster --name agentic-os`.

## Validate the slice (the success gate)

```bash
# RAG answer grounded in OpenSearch-retrieved context, traced in Langfuse:
kubectl -n agentic-os run ask --rm -i --restart=Never --image=curlimages/curl:8.11.1 -- \
  curl -sS http://sample-agent:8000/ask -G \
  --data-urlencode "q=What provides the retrieval backbone for vector and lexical search?"

# See the trace (uses the headless-provisioned dev keys):
kubectl -n agentic-os run lf --rm -i --restart=Never --image=curlimages/curl:8.11.1 -- \
  curl -sS -u pk-lf-localdev0000public:sk-lf-localdev0000secret \
  http://agentic-os-langfuse-web:3000/api/public/traces?limit=5
```

Open the UIs:
```bash
kubectl -n agentic-os port-forward svc/agentic-os-langfuse-web 3000:3000   # Langfuse
kubectl -n agentic-os port-forward svc/agentic-os-litellm 4000:4000        # LiteLLM
```

## Pinned versions (agent-core slice)

| Thing | Version |
|---|---|
| Umbrella chart | 0.2.0 |
| Langfuse chart / app | 1.5.36 / v3.194.1 |
| LiteLLM chart | 1.90.0 |
| OpenSearch chart | 3.7.0 |
| CloudNativePG operator chart | 0.28.3 (op 1.29.1) |
| Postgres image | 17.5 (digest-pinned) |
| ClickHouse / Valkey / SeaweedFS | 24.8 / 8.1-alpine / 3.97 (digest-pinned) |
| Agent deps | langgraph 0.3.34, langfuse 3.15.0, openai 1.109.1 |

## Build order (incremental — thinnest runnable slice first)

Each step was added to the same chart, installed, and validated before the next.
**Step 1 is complete — all eight are running and validated on kind:**

1. ✅ Umbrella scaffold (lint gate)
2. ✅ kind cluster + object storage (SeaweedFS) — bucket + S3 put/get
3. ✅ CloudNativePG operator + Postgres `Cluster` — `langfuse` DB healthy
4. ✅ Valkey + ClickHouse — auth + DDL
5. ✅ Langfuse v3 (wired to all four backends) — health OK, 70 PG + 12 CH tables
6. ✅ LiteLLM gateway + local mock model — chat + embeddings via the gateway
7. ✅ OpenSearch + sample knowledge index — kNN search
8. ✅ Sample LangGraph agent → **success gate**: RAG answer + Langfuse trace

### Layer 2 (Context / Foundations) — all 7 built and validated

Added incrementally on the same chart (light→heavy), each validated + committed:

1. ✅ **OPA** — default-deny tool authorization (rag allowed, web_fetch denied)
2. ✅ **Docling** — doc parsing (HTML→markdown)
3. ✅ **Haystack** — RAG retrieval pipeline over OpenSearch (embeds via LiteLLM)
4. ✅ **Dagster** — orchestrator on CNPG (arm64-native image; assets load in the UI)
5. ✅ **dbt** — seed→staging→mart into the CNPG `warehouse`
6. ✅ **Cube** — metrics over the dbt warehouse (revenue by day)
7. ✅ **OpenMetadata** — catalog/lineage on CNPG + OpenSearch (175 tables, search indices)

**Build-and-toggle (RAM):** the full L1+L2 set is sized for a 96 GB STACKIT node;
on a 14 GB local VM, `values.local.yaml` turns **Docling** and **OpenSearch
Dashboards** off to make room for OpenMetadata. Product defaults (`values.yaml`)
keep everything enabled for STACKIT; flip the local toggles (or scale the VM) to
run them together.

### Secure-by-default egress baseline (security.md) — done

Agents get no raw internet; outbound is granted, proxied, allowlisted, audited:

- ✅ **Egress proxy** (tinyproxy) — single outbound chokepoint, deny-by-default
  domain allowlist (allowlisted → through; others → blocked).
- ✅ **Governed `web_fetch` tool** — the only sanctioned path to the web:
  OPA-authorized per principal (grant-per-key), routed through the proxy, returns
  sanitized content as DATA. Validated: ungranted → 403; granted+allowlisted →
  200; granted+non-allowlisted → proxy-blocked.
- ✅ **Default-deny NetworkPolicies** — shipped ON; deny egress except DNS /
  intra-namespace / API-server, and only the proxy reaches the internet. (kindnet
  doesn't enforce locally; Cilium enforces on STACKIT.)

### Dagster → dbt — done

The Dagster image bundles dbt + dagster-dbt; dbt models load as Dagster assets
(`daily_revenue`/`stg_orders`/`raw_orders`) and materializing them runs `dbt
build` against the warehouse (validated: RUN_SUCCESS).

Remaining for later: Layer 3 (MCP tools + central Trino/Iceberg + Superset) + the OS UI.

### Data tier wiring (Layer 2)

`dbt` builds models into the CNPG **warehouse** → `Cube` serves metrics over them →
`OpenMetadata` catalogs everything, searching via **OpenSearch**. `Dagster`
orchestrates (dbt-as-assets is the next wiring). `Haystack` + `Docling` feed the
**knowledge** RAG path the agents already use.

## What runs (10 workloads)

`seaweedfs` · `pg-1` (CloudNativePG) · `valkey` · `clickhouse` · `agentic-os-langfuse-web`
· `agentic-os-langfuse-worker` · `agentic-os-litellm` · `mock-model` · `opensearch-master-0`
· `sample-agent`. Pod requests sum to a few vCPU / ~7 GB; comfortable on a 6 CPU / 14 GB VM.

## Notes & learnings (step 1)

- **Operators are a bootstrap concern, not in-release.** CloudNativePG ships a `Cluster`
  CRD + admission webhook; a single `helm install` that also creates the `Cluster` races
  the webhook. Split out into `scripts/bootstrap-local.sh` (matches `stackit.md` §2). The
  `kubectl apply --dry-run=client` gate therefore needs the CRDs present first.
- **Bitnami images are now paywalled/"legacy".** Langfuse's and LiteLLM's bundled
  subcharts default to `bitnamilegacy/*`. We disable them and wire our own permissive
  backends (CloudNativePG / ClickHouse / Valkey / SeaweedFS) — which the spec mandates
  anyway. This is the main reason to wire external backends explicitly.
- **CNPG rejects digest-only images** (`spec.imageName`) — it needs a tag for upgrade
  detection. Use `tag@digest` to pin *and* satisfy it.
- **Langfuse requires Valkey `noeviction`** (it's a job queue) and **`clusterEnabled:false`**
  for a single-node external ClickHouse (else it issues `ON CLUSTER` DDL that fails).
- **LiteLLM OOMs under ~1 GiB** at startup (import-heavy). 1.5 GiB limit is stable. Run
  DB-less for the thin slice; DB-backed virtual keys + cost caps (against CNPG) is a
  fast-follow that security.md wants.
- **SeaweedFS all-in-one** doesn't recover its raft leader after a kill, so it runs with
  **no livenessProbe** (startup+readiness only) as an ephemeral local stand-in.
- **Local secrets** are chart-created only under `profile: local` and clearly marked dev
  throwaways; nothing real is committed. On STACKIT every one of these is external.

## Conventions

- **No secrets in git.** Secrets are external (k8s Secret / External Secrets references).
  `.gitignore` blocks key/secret patterns; the chart ships only sane secure defaults.
- Pin upstream chart versions (`Chart.yaml`) and image digests (`values.yaml`).
- Only permissively-licensed components are bundled (see `../stackit/stack-decisions.md`);
  not-bundled boundaries honored (LangGraph Platform, Langfuse `/ee`, ELv2 tools).
- Commits: `aborek <alex@datamasterclass.com>`, small and clear.

## License & Trademarks

- **Core — Apache-2.0.** Borek Data Ventures UG's own code (the OS UI, integration glue,
  bespoke images, and the Helm chart) is licensed under the **Apache License 2.0** — see
  [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
- **Bundled components keep their own licenses.** The platform **aggregates** independent
  open-source components, each under its own license — we do **not** relicense them. The
  full attribution manifest (component, version, SPDX id, and a pointer to the bundled
  full license text under [`licenses/`](licenses/)) is in
  [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md); a CycloneDX SBOM ships as
  [`sbom.cdx.json`](sbom.cdx.json). Notably, **Forgejo (GPL-3.0-or-later) ships as a
  separate service (mere aggregation)** and **Featureform (MPL-2.0) is optional**; their
  source records are in [`licenses/source-offer.md`](licenses/source-offer.md).
- **Trademarks.** "**Sovereign Agentic OS**" and "**Data Masterclass**" are trademarks of
  **Borek Data Ventures UG**. All other names/marks are the property of their respective
  owners. This project is **not affiliated with, or endorsed by, the Apache Software
  Foundation**.
- **Enterprise Edition.** Any future Enterprise features ship under [`ee/`](ee/) with their
  **own commercial license** (separate from Apache-2.0), gated behind a license key — see
  [`ee/README.md`](ee/README.md). The free core stays complete and open.
- **Contributing.** Contributions are accepted into the Apache-2.0 core under a DCO
  sign-off (`git commit -s`) — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

> Not legal advice — counsel should review before the public launch.
