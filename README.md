# Sovereign Agentic OS

A governed operating system for building and running AI agents on your own infrastructure.
Agents are built as **LangGraph** graphs, call tools through **one** MCP dispatcher, read data,
files, knowledge and connections through **policy-checked** paths, route every model call through
**LiteLLM**, and emit **one trace per run**. Everything runs in your cluster — no SaaS dependency.

It runs on a laptop first. The same chart runs on a managed Kubernetes cluster.

---

## Quickstart

```bash
git clone https://github.com/Data-Masterclass/sovereign-agentic-os.git
cd sovereign-agentic-os
./scripts/os up
```

Prerequisites: Docker (Colima or Docker Desktop, ~8 GB to the VM), `kind`, `helm`, `kubectl`, `python3`.

`os up` creates a kind cluster, builds the images for your architecture, installs the chart and
prints the URL. First run takes ~10–15 minutes (image builds); later runs a few minutes.

```
UI:     http://localhost:8080     login: admin / admin  (you set a real email + password on first login)
MCP:    http://localhost:8080/api/mcp
```

Without an API key the OS serves a **mock model** so everything is clickable offline. For real
models, export a key for an OpenAI-compatible endpoint before `os up`:

```bash
export STACKIT_API_KEY=...   # routes LiteLLM at STACKIT AI Model Serving
./scripts/os up
```

Other commands:

```bash
./scripts/os test     # unit tests + regression gate + chart lint (+ health when the cluster is up)
./scripts/os down     # delete the cluster
make up / test / down # the same three
```

---

## The 13 tabs

| Group | Tabs |
|---|---|
| Entry | Home · MCP · About / Licenses |
| Context | Data · Metrics · Files · Knowledge |
| Build | **Workflows** · Agents · Dashboards · Software |
| Manage | Connections · Governance · Monitoring · Admin |

Every tab is reachable from the UI and from MCP with the same permissions — the MCP server is a
front door to the same governed code, not a back door around it.

Scope ladder for every artifact: **My → Domain → Company**. A promotion to Domain needs a
domain admin's approval, a promotion to Company needs a platform admin's; a Company artifact is
visible to everyone in the tenant regardless of domain. Approvals land in **Governance**.

---

## What runs

| | Component | Why |
|---|---|---|
| Kernel | os-ui (Next.js — UI + MCP server) | the application |
| | OpenSearch | user directory, search and derived indexes |
| | PostgreSQL (CloudNativePG) | control-plane state, Langfuse, LiteLLM, Dagster, catalog |
| | Valkey | queues and caches |
| | MinIO | files, lakehouse objects, backups |
| | LiteLLM | the only model gateway |
| | OPA | authorization, fail-closed |
| | agent-runtime | LangGraph execution |
| | Langfuse + ClickHouse | run traces |
| | egress-proxy, web-fetch | governed outbound HTTP |
| Data | Trino, Polaris, dbt, data-runner, query-tool | SQL, Iceberg catalog, transforms |
| Data/Files/Knowledge | Dagster | scheduled syncs and pipelines (SQL sources, OneDrive/Drive, re-indexing) |
| Files | Docling | PDF/Office text extraction |

Optional pieces are declared per tab: if a service is disabled, its tab is absent from the
navigation instead of broken.

---

## Repository layout

```
charts/sovereign-agentic-os/   the one Helm chart (local defaults; values.stackit-managed.yaml overlays a cloud install)
os-ui/                         the application: UI, API routes, MCP server, agent build + run
images/                        the images we build (os-ui, agent-runtime, egress-proxy, web-fetch, mock-model, dbt, dagster, data-runner, query-tool)
scripts/os                     local lifecycle: up · test · down
deploy/                        Terraform (targeted) and Velero backups for the managed install
docs/superpowers/plans/        the rework plan of record
```

---

## Deploying to a real cluster

```bash
helm upgrade --install agentic-os charts/sovereign-agentic-os -n agentic-os --create-namespace \
  -f values.stackit-managed.yaml -f values.private.yaml
```

`values.private.yaml` (git-ignored) holds your keys; `values.private.example.yaml` shows the shape.
Back up before every upgrade: `deploy/pre-upgrade-backup.sh`.

---

## Licence

Apache-2.0 — see `LICENSE`, `NOTICE` and `THIRD-PARTY-LICENSES.md`.
Contributions: `CONTRIBUTING.md` and `CLA.md`. Security reports: `SECURITY.md`.
