# Sovereign Agentic OS

**The open, sovereign operating layer for enterprise AI agents — runs entirely in your own cloud.**

> ⚠️ **Pre-beta / experimental — `v0.1.0-alpha.1`.** Not production-ready. APIs, chart values,
> and the database schema may change without notice. Published for **evaluation and feedback** —
> please try it and open issues. 🙏

> 📖 **New here? Read the [Sovereign Agentic OS Guide](docs/Sovereign-Agentic-OS-Guide.md)**
> ([PDF](docs/Sovereign-Agentic-OS-Guide.pdf)) — the full install/operate/understand manual.

---

Sovereign Agentic OS assembles ~two dozen best-in-class, permissively-licensed open-source tools
into **one governed stack** where every business **domain** can create, use, govern, and share its
data, knowledge, dashboards, agents, software, and ML. It ships as **one umbrella Helm chart** that
runs on **your** Kubernetes — a laptop (`kind`), STACKIT (EU/Germany), Azure, on-prem, or fully
air-gapped — keeps your data and inference under your control, and has **no vendor lock-in**.

The default install is **fully self-contained and works out of the box**: every backend runs inside
the chart and a tiny local **mock LLM** stands in for a model provider, so **nothing external and no
API key** is required to see the whole system working end to end.

## Why "sovereign"?

- **Owned by you** — runs in your own cloud/tenant; data and inference never leave your jurisdiction.
- **Permissive open source only** — every bundled component is Apache-2.0 / MIT / BSD / PostgreSQL;
  the UI is in the free core. No closed core, no lock-in, fully auditable.
- **Portable** — the *same* chart runs on `kind`, STACKIT, Azure, or air-gapped. Mode is one value
  per backend (`bundled | external`).
- **Secure & governed by default** — agents have no raw internet, every tool call is OPA-authorized,
  every model call is metered and traced (Langfuse), and no real secret ever lives in git.

## What's inside

| Layer | Capability | Built on |
|---|---|---|
| **1 · Agent core** | Multi-agent runtime, model + MCP gateway, observability, retrieval | LangGraph · LiteLLM · Langfuse v3 · OpenSearch |
| **2 · Context** | Policy, RAG, transforms, metrics, catalog, orchestration | OPA · Docling · Haystack · dbt · Cube · OpenMetadata · Dagster |
| **3 · Self-service** | Lakehouse, query, BI, software delivery, MCP tools | Iceberg/Polaris · DuckDB/Trino · Superset · Forgejo · Argo CD · MCP |
| **4 · Science** *(opt-in, off by default)* | Notebooks, feature store, model training + serving | JupyterHub · MLflow · Featureform · KServe |

All permissively licensed — see [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md).

> **Scope of this release.** Layers **1–3** are built (incrementally), with **Layer 4 (Science/ML)**
> available opt-in/off-by-default, under a secure-by-default baseline. The **OS UI** ships with real
> surfaces (Home, Agents, Knowledge, Structured Data, Software, Monitoring, Governance, Gateway,
> Orchestration, Consoles); **per-domain spaces, identity (Ory), and the cross-domain marketplace are
> the next build.**

## Quickstart (local, ~5 minutes)

**Prerequisites:** a running container runtime + `docker`, plus `kind`, `helm`, `kubectl` on your
`PATH`, and ~**14 GB RAM / 6 CPU** for the VM (the slice is RAM-bound).

```bash
git clone https://github.com/Data-Masterclass/sovereign-agentic-os
cd sovereign-agentic-os
./install.sh            # press Enter through every prompt = fully self-contained
```

`install.sh` creates the `kind` cluster, bootstraps the operators, builds and loads the images,
installs the chart, seeds the demo data, and prints the **front doors** and **demo logins**. No
external service or API key is needed — a local mock LLM answers model calls.

**The two front doors:**

```bash
kubectl -n agentic-os port-forward svc/os-ui 8080:3000          # OS UI       → http://localhost:8080
kubectl -n agentic-os port-forward svc/admin-console 8081:8080  # Admin Console → http://localhost:8081
```

The **OS UI** is the product front door (Agents chat, Knowledge, data, software, monitoring,
governance). The **Admin Console** operates the stack (component status, on/off toggles, addresses,
logins, and in-app docs).

## Golden paths

Four end-to-end workflows ship seeded and work immediately after install:

1. **Ask an agent (RAG)** — a LangGraph agent retrieves over OpenSearch, generates via LiteLLM, and is traced in Langfuse.
2. **Query the lakehouse** — DuckDB SQL over Iceberg, exposed as an OPA-gated `query` MCP tool through the LiteLLM gateway.
3. **Build a dashboard** — Superset on dbt-modeled data with Cube metrics.
4. **Ship software** — `git push` → Forgejo Actions CI → image build → Argo CD GitOps redeploy.

## Deployment modes

- **Self-contained (default)** — every backend bundled; one command; runs anywhere, air-gappable, scales to zero with the cluster.
- **Managed overlay** — point stateful backends at your cloud's managed services (on STACKIT: PostgreSQL Flex / OpenSearch / Object Storage, and **STACKIT AI Model Serving** for sovereign LLM inference). Same chart; `install.sh` asks per backend. See the [Guide → Deploying to your cloud](docs/Sovereign-Agentic-OS-Guide.md).

## Documentation

- 📖 **[Sovereign Agentic OS Guide](docs/Sovereign-Agentic-OS-Guide.md)** ([PDF](docs/Sovereign-Agentic-OS-Guide.pdf)) — the complete manual: install, front doors, golden paths, component reference, security model, cloud deployment, troubleshooting.
- Per-component guides in [`docs/components/`](docs/components).

## License & editions

- **Core: Apache-2.0** — free and open, **including the UI**. See [`LICENSE`](LICENSE).
  Copyright © 2026 **Borek Data Ventures UG (haftungsbeschränkt)** (see [`NOTICE`](NOTICE)).
- Bundled third-party components keep their **own** licenses — listed in
  [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md), texts under [`licenses/`](licenses).
- An **Enterprise Edition** (advanced governance, support) may follow under a separate commercial
  license — the core stays open.
- "Sovereign Agentic OS" and "Data Masterclass" are **trademarks** of Borek Data Ventures UG
  (haftungsbeschränkt) — see [`TRADEMARKS.md`](TRADEMARKS.md). A code license is not a trademark
  license. **Not affiliated with the Apache Software Foundation.**

## Status

**Pre-beta.** Expect rough edges and breaking changes. Feedback, issues, and PRs are very welcome —
see [`CONTRIBUTING.md`](CONTRIBUTING.md) (a one-time [CLA](CLA.md) is required).

---

Built by [**Data Masterclass**](https://datamasterclass.com) — the fast track for data & AI leaders.
