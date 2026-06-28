# Third-party licenses — Sovereign Agentic OS

The Sovereign Agentic OS **aggregates** independent open-source components, each
**under its own license**. We do **not** relicense them; Borek Data Ventures UG's own
code is Apache-2.0 (see `LICENSE` / `NOTICE`).

This file is the **attribution manifest**: every bundled component, its version, its
SPDX license identifier, and a pointer to the **full license text bundled locally**
under `licenses/`. Everything is **offline-complete** — unpacking the single artifact
(chart `.tgz` / air-gap image bundle) reveals every license without network access.

- Full license texts: `licenses/<SPDX-ID>.txt`
- Bundled component NOTICE files: `licenses/notices/`
- Copyleft source records + written offer: `licenses/source-offer.md`
- Machine-readable mirror (drives the CI gate): `licenses/components.tsv`
- SBOM (CycloneDX, syft-generated): `sbom.cdx.json`

## How this was generated / kept in sync

Derived from the umbrella chart (`charts/sovereign-agentic-os/Chart.yaml`) and the
image references in `charts/sovereign-agentic-os/values.yaml`, cross-checked against a
**syft** SBOM:

```bash
# install: brew install syft   (or download the binary from github.com/anchore/syft)
syft scan dir:. -o cyclonedx-json=sbom.cdx.json     # regenerate the SBOM
scripts/license-check.sh --update-sbom              # refresh SBOM + run the allowlist gate
```

Regenerate `sbom.cdx.json` and reconcile this manifest **on every release** (see the
Release process section at the bottom).

---

## Components

Licenses in use and their bundled full text:

| SPDX id | Full text |
|---|---|
| Apache-2.0 | `licenses/Apache-2.0.txt` |
| MIT | `licenses/MIT.txt` |
| BSD-2-Clause | `licenses/BSD-2-Clause.txt` |
| BSD-3-Clause | `licenses/BSD-3-Clause.txt` |
| ISC | `licenses/ISC.txt` |
| 0BSD | `licenses/0BSD.txt` |
| PostgreSQL | `licenses/PostgreSQL.txt` |
| MPL-2.0 | `licenses/MPL-2.0.txt` |
| GPL-3.0-or-later | `licenses/GPL-3.0.txt` |
| AGPL-3.0 (dev-only, not bundled) | `licenses/AGPL-3.0.txt` |

### Agent core & gateway

| Component | Version | License (SPDX) | Full text | Notes |
|---|---|---|---|---|
| LangGraph (library) | 0.3.34 | MIT | `licenses/MIT.txt` | MIT **library** only — the Elastic-licensed LangGraph Platform/API server is **not** bundled |
| LiteLLM | chart 1.90.0 | MIT | `licenses/MIT.txt` | Model / MCP gateway |
| Langfuse (core) | chart 1.5.36 / app 3.194.1 | MIT | `licenses/MIT.txt` | Observability core; the `/ee` modules are license-gated and **not** shipped |

### Retrieval, data & catalog

| Component | Version | License (SPDX) | Full text | Notes |
|---|---|---|---|---|
| OpenSearch | chart 3.7.0 | Apache-2.0 | `licenses/Apache-2.0.txt` | NOTICE: `licenses/notices/OpenSearch-NOTICE.txt` |
| OpenSearch Dashboards | chart 3.7.0 | Apache-2.0 | `licenses/Apache-2.0.txt` | |
| ClickHouse | 24.8 | Apache-2.0 | `licenses/Apache-2.0.txt` | Langfuse analytics backend |
| Valkey | 8.1 | BSD-3-Clause | `licenses/BSD-3-Clause.txt` | Cache/queue (**not** Redis/SSPL) |
| PostgreSQL | 17.5 | PostgreSQL | `licenses/PostgreSQL.txt` | CloudNativePG-managed image |
| CloudNativePG (operator) | chart 0.28.3 / op 1.29.1 | Apache-2.0 | `licenses/Apache-2.0.txt` | Bootstrap prerequisite |
| dbt Core | 0.1.0 image | Apache-2.0 | `licenses/Apache-2.0.txt` | Transformations |
| Haystack | in retriever image | Apache-2.0 | `licenses/Apache-2.0.txt` | RAG pipeline |
| Cube | digest-pinned | Apache-2.0 | `licenses/Apache-2.0.txt` | Semantic/metrics layer |
| OpenMetadata | chart 1.13.0 | Apache-2.0 | `licenses/Apache-2.0.txt` | Catalog/lineage |
| Docling | digest-pinned | MIT | `licenses/MIT.txt` | Document parsing |
| OPA (Open Policy Agent) | 1.4.2 | Apache-2.0 | `licenses/Apache-2.0.txt` | Policy-as-code |
| Dagster | chart 1.13.11 | Apache-2.0 | `licenses/Apache-2.0.txt` | Orchestrator |
| DuckDB | in query-tool image | MIT | `licenses/MIT.txt` | Default lakehouse query engine |
| Apache Polaris | 1.0.1-incubating | Apache-2.0 | `licenses/Apache-2.0.txt` | NOTICE: `licenses/notices/Apache-Polaris-NOTICE.txt` |
| Superset | chart 0.17.2 / app 6.1.0 | Apache-2.0 | `licenses/Apache-2.0.txt` | NOTICE: `licenses/notices/Apache-Superset-NOTICE.txt` |
| Trino | optional (off) | Apache-2.0 | `licenses/Apache-2.0.txt` | Optional scale/federation engine |
| Apache Spark | optional (off) | Apache-2.0 | `licenses/Apache-2.0.txt` | Optional; NOTICE: `licenses/notices/Apache-Spark-NOTICE.txt` |
| SeaweedFS | 3.97 | Apache-2.0 | `licenses/Apache-2.0.txt` | Air-gap object storage |
| Supabase | platform | Apache-2.0 | `licenses/Apache-2.0.txt` | |

### Software delivery & platform

| Component | Version | License (SPDX) | Full text | Notes |
|---|---|---|---|---|
| **Forgejo** | **v11.0.15** (chart 17.1.1) | **GPL-3.0-or-later** | `licenses/GPL-3.0.txt` | **Ships as a SEPARATE SERVICE (mere aggregation)** — own pod, not linked into our code. Source repo + commit + written offer: `licenses/source-offer.md` |
| Forgejo Runner | 6 | MIT | `licenses/MIT.txt` | CI runner (act_runner) |
| Argo CD | chart 10.0.0 | Apache-2.0 | `licenses/Apache-2.0.txt` | GitOps deploy |
| Harbor | platform | Apache-2.0 | `licenses/Apache-2.0.txt` | Production registry |
| Velero | platform | Apache-2.0 | `licenses/Apache-2.0.txt` | Backup/restore |
| cert-manager | platform | Apache-2.0 | `licenses/Apache-2.0.txt` | TLS certificate management |
| Cilium | platform | Apache-2.0 | `licenses/Apache-2.0.txt` | CNI / NetworkPolicy enforcement |
| Ory | platform | Apache-2.0 | `licenses/Apache-2.0.txt` | Identity / auth federation |

### Layer 4 — Science / ML (optional, `ml.enabled=false`)

| Component | Version | License (SPDX) | Full text | Notes |
|---|---|---|---|---|
| JupyterHub | Layer 4 (off) | BSD-3-Clause | `licenses/BSD-3-Clause.txt` | Notebooks |
| **Featureform** | **v0.12.1** | **MPL-2.0** | `licenses/MPL-2.0.txt` | **OPTIONAL** feature store. File-level copyleft. Source repo + commit: `licenses/source-offer.md` |
| MLflow | Layer 4 (off) | Apache-2.0 | `licenses/Apache-2.0.txt` | Experiment tracking / model registry |
| KServe | Layer 4 (off) | Apache-2.0 | `licenses/Apache-2.0.txt` | Model serving / inference |

### Helper / demo images

| Component | Version | License (SPDX) | Full text | Notes |
|---|---|---|---|---|
| amazon/aws-cli | 2.31.13 | Apache-2.0 | `licenses/Apache-2.0.txt` | Bucket-init helper |
| traefik/whoami | 1.10.3 | MIT | `licenses/MIT.txt` | Software-delivery demo app |
| Docker-in-Docker (dind) | 27 | Apache-2.0 | `licenses/Apache-2.0.txt` | CI build sidecar (Moby/Docker) |

### Referenced but NOT bundled

| Component | Version | License (SPDX) | Notes |
|---|---|---|---|
| MinIO | digest-pinned | AGPL-3.0 | **Local dev-only S3 stand-in.** AGPL — **never bundled/redistributed** in the product. SeaweedFS (Apache-2.0) is the bundled/air-gap object store. Full text kept for transparency at `licenses/AGPL-3.0.txt`. |

> Our own images (`sovereign-os/*`: mock-model, sample-agent, poet-agent,
> haystack-retriever, query-tool, dbt, dagster, superset, egress-proxy, web-fetch,
> admin-console, os-ui, ci-builder) are **Borek Data Ventures UG** code under
> **Apache-2.0** (`LICENSE`) and carry SPDX headers.

---

## Copyleft source availability

- **Forgejo (GPL-3.0-or-later)** — bundled as a separate, unmodified service. Exact
  source repo, version, and commit, plus the written offer for the air-gap bundle, are
  recorded in `licenses/source-offer.md`.
- **Featureform (MPL-2.0)** — optional; exact source repo/version/commit in
  `licenses/source-offer.md`.

The air-gap bundle (per `stackit/packaging.md`) ships `sbom.cdx.json`, this manifest,
and the whole `licenses/` directory alongside the mirrored images.

## Release process

On every release:

1. `scripts/license-check.sh --update-sbom` — regenerate `sbom.cdx.json` (syft) and run
   the allowlist gate (`licenses/allowed-licenses.txt`).
2. Reconcile this manifest + `licenses/components.tsv` with any added/updated/removed
   components and pinned versions in `Chart.yaml` / `values.yaml`.
3. Add the full license text for any **new** license under `licenses/`, and the
   component's NOTICE (if it ships one) under `licenses/notices/`.
4. Update `licenses/source-offer.md` if a copyleft component's pinned version changed.

The CI gate (`.github/workflows/license-gate.yml`) fails the build if a component's
license is not on the allowlist (blocks ELv2 / BSL / SSPL / AGPL-when-bundled).
