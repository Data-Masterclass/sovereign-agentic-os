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
scripts/license-check.sh --update-sbom              # refresh SBOM + run the licence gate (licenses/policy.json)
```

Regenerate `sbom.cdx.json` and reconcile this manifest **on every release** (see the
Release process section at the bottom).

---

## Licence policy (owner decision, 2026-11-22, refined)

One policy for the **whole repo** — OS code, images, chart components and app templates. It replaces the
earlier "Apache/MIT/BSD/ISC only" rule. The lists live in **one file**, `licenses/policy.json`, which the
gate (`scripts/license-gate.mjs`, run by `scripts/license-check.sh` and CI) reads.

- **Permissive only for our own code and everything linked into it.** Allowed: Apache-2.0, MIT, MIT-0, BSD-2-Clause,
  BSD-3-Clause (the plain "BSD License" classifier resolves to this), ISC, 0BSD, Zlib, Unlicense, BlueOak-1.0.0,
  PostgreSQL, PSF-2.0 / Python-2.0, and — for data and docs — CC-BY-4.0 and CC0-1.0.
- **Only through a reviewed exception:** unmodified weak-copyleft libraries (MPL, LGPL, EPL, CDDL) and unmodified
  separate GPL programs (for example `git` in the git-http, git-daemon and backup-tools images). Each entry in
  `licenses/exceptions.json` needs a reason, a reviewer, and the condition `unmodified-not-linked` (a library used
  unmodified, not linked into our code) or `separate-program` (its own process; the only condition a GPL accepts).
  The gate checks the condition.
- **Never allowed, never excepted:** AGPL, strong copyleft linked into our code (EUPL, and GPL anywhere but as a
  separate program), and source-available licences (BUSL/BSL, SSPL, Elastic-2.0, Commons Clause, CC-BY-NC-*, CC-BY-SA-*).
- **Unknown or unlicensed:** fails, unless an entry in `licenses/exceptions.json` carries a reviewed reason.
- **Dual-licensed** (`A OR B`): passes if any option is allowed; the gate prints which option it chose.
  (`A AND B` needs both allowed.)
- **Attribution:** every dependency whose chosen licence is not Apache-2.0 or MIT — excepted ones included — needs an
  entry in this file or in `licenses/ATTRIBUTIONS.md` (generated: `node scripts/license-gate.mjs --python-resolve
  --write-attributions`). The gate fails when one is missing.
- **Known violations:** `licenses/known-violations.json` lists the findings that existed on main when the
  policy began. It is a ratchet, not a waiver: each run prints them, `--strict` fails on them, a new finding
  fails, and an entry whose package is fixed is reported STALE and fails — so the list only shrinks.

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
| LiteLLM | chart 1.109.1 | MIT | `licenses/MIT.txt` | Model / MCP gateway |
| Langfuse (core) | chart 1.5.36 / app 3.194.1 | MIT | `licenses/MIT.txt` | Observability core; the `/ee` modules are license-gated and **not** shipped |

#### os-ui agent engine — npm libraries (engine rebuild, Phase A0)

Node.js dependencies of our own `os-ui` code (`os-ui/package.json`, exact-pinned), traced into
the os-ui image. Per-package copyright notices: `licenses/notices/os-ui-agent-engine-npm-NOTICE.txt`.

| Component | Version | License (SPDX) | Full text | Notes |
|---|---|---|---|---|
| @langchain/langgraph (JS) | 1.7.4 | MIT | `licenses/MIT.txt` | The in-process graph engine for agent systems (MIT **library**; the Elastic-licensed LangGraph Platform is **not** bundled) |
| @langchain/langgraph-checkpoint-postgres | 1.1.3 | MIT | `licenses/MIT.txt` | Run checkpoints in the existing CNPG Postgres (`agent_runs` database) |
| @langchain/core (JS) | 1.4.0 | MIT | `licenses/MIT.txt` | Peer dependency of the two above, pinned explicitly |
| pg (node-postgres) | 8.23.1 | MIT | `licenses/MIT.txt` | Postgres driver used by the checkpointer |
| pg-boss | 12.38.2 | MIT | `licenses/MIT.txt` | The one job queue (reconcilers, outbox, schedules), installed in its own Postgres schema `pgboss` |
| node-pg-migrate | 9.0.0 | MIT | `licenses/MIT.txt` | Applies the plain-SQL migrations of the Postgres `os_governance` schema |
| langfuse (JS SDK v3) | 3.39.2 | MIT | `licenses/MIT.txt` | One Langfuse trace per run (trace id = run id). The npm tarball ships no LICENSE file; `package.json` declares MIT and the upstream text is reproduced in the NOTICE file |

#### os-ui git store — npm library (engine rebuild, Phase B1)

| Component | Version | License (SPDX) | Full text | Notes |
|---|---|---|---|---|
| isomorphic-git | 1.44.13 | MIT | `licenses/MIT.txt` | In-process git for the per-domain data-product repositories (bare repos on the `os-repos` PVC; commit/log/read/archive/push). Notice: `licenses/notices/os-ui-git-store-npm-NOTICE.txt`. The `git` binary (GPL-2.0) is NOT bundled by os-ui; the chart runs it as a separate process from the stock `alpine/git` image (git daemon) and the Dagster image's distro package (repo-sync) |
| Apache ECharts (JS, os-ui npm) | 5.6.0 | Apache-2.0 | `licenses/Apache-2.0.txt` | The OS UI chart renderer (dashboard panels, query results, app charts). ONE registration surface at `os-ui/core/ui/charts`; the line/area/bar transformers are the vendored Apache Superset slice below |
| js-yaml (JS, os-ui npm) | 4.1.0 | MIT | `licenses/MIT.txt` | YAML reader for dashboard-as-code (`dashboards/<slug>/dashboard.yaml`) and agent `system.yaml` |
| smol-toml (JS, os-ui npm) | 1.9.1 | BSD-3-Clause | `licenses/BSD-3-Clause.txt` | TOML reader for an app's `bunfig.toml` in the Software tab's dependency scan (`tabs/software/lib/scope-pin.ts`) |

Deliberately **not** added: `langfuse-langchain@3` — its peer range is the legacy `langchain <0.4`
(`@langchain/core` 0.x), incompatible with `@langchain/core@1` that LangGraph 1.x requires; its
successor `@langfuse/langchain@6` (OTel-based) is the alternative if a LangChain callback
handler is ever needed. Model calls go through LiteLLM via our own `LlmCall`, not LangChain chat
models, so run tracing is done explicitly with the `langfuse` SDK.

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
| DuckDB | in sandbox-duckdb image | MIT | `licenses/MIT.txt` | Personal/sandbox lane engine (behind Trino) |
| Apache Polaris | 1.0.1-incubating | Apache-2.0 | `licenses/Apache-2.0.txt` | NOTICE: `licenses/notices/Apache-Polaris-NOTICE.txt` |
| Superset | chart 0.17.2 / app 6.1.0 | Apache-2.0 | `licenses/Apache-2.0.txt` | NOTICE: `licenses/notices/Apache-Superset-NOTICE.txt` |
| Apache Superset (vendored source) | `c83fb2bb1dcfac41ac51bcebd82471f4a7180d18` | Apache-2.0 | `licenses/Apache-2.0.txt` | Pure chart transformers vendored into `os-ui/vendor/superset/`, pinned to a commit sha; NOTICE: `licenses/notices/Apache-Superset-NOTICE.txt` |
| Trino | 476 | Apache-2.0 | `licenses/Apache-2.0.txt` | Central governed query engine (all shared marts) |
| Apache Spark | optional (off) | Apache-2.0 | `licenses/Apache-2.0.txt` | Optional; NOTICE: `licenses/notices/Apache-Spark-NOTICE.txt` |
| SeaweedFS | 3.97 | Apache-2.0 | `licenses/Apache-2.0.txt` | Air-gap object storage |
| Supabase | platform | Apache-2.0 | `licenses/Apache-2.0.txt` | |

### Software delivery & platform

| Component | Version | License (SPDX) | Full text | Notes |
|---|---|---|---|---|
| Conftest | 0.56.0 | Apache-2.0 | `licenses/Apache-2.0.txt` | CI-only binary. Pre-merge OPA/Rego policy gate for the `analytics` monorepo (#146). Pinned in the seeded `.forgejo/workflows/ci.yml`; **not** bundled in a runtime image (downloaded by the CI job). |
| Argo CD | chart 10.0.0 | Apache-2.0 | `licenses/Apache-2.0.txt` | GitOps deploy |
| Harbor | platform | Apache-2.0 | `licenses/Apache-2.0.txt` | Production registry |
| Velero | platform | Apache-2.0 | `licenses/Apache-2.0.txt` | Backup/restore |
| git (backup-tools, git-daemon and git-http images) | 2.47.3 | GPL-2.0-only | `licenses/GPL-2.0.txt` | Unmodified Alpine package, a separate tool binary run as its own process (`git bundle`/`fsck` for WP-56 backups, `git daemon`, `git-http-backend`); never linked into OS code — mere aggregation |
| cert-manager | platform | Apache-2.0 | `licenses/Apache-2.0.txt` | TLS certificate management |
| External Secrets Operator | chart 2.15.0 | Apache-2.0 | `licenses/Apache-2.0.txt` | Secrets from STACKIT Secrets Manager (WP-10). Its own release (`deploy/external-secrets/`); the optional `bitwarden-sdk-server` subchart stays disabled. |
| Cilium | platform | Apache-2.0 | `licenses/Apache-2.0.txt` | CNI / NetworkPolicy enforcement |
| Ory | platform | Apache-2.0 | `licenses/Apache-2.0.txt` | Identity / auth federation |

### Layer 4 — Science / ML (optional, `ml.enabled=false`)

| Component | Version | License (SPDX) | Full text | Notes |
|---|---|---|---|---|
| JupyterHub | Layer 4 (off) | BSD-3-Clause | `licenses/BSD-3-Clause.txt` | Notebooks |
| MLflow | Layer 4 (off) | Apache-2.0 | `licenses/Apache-2.0.txt` | Experiment tracking / model registry |
| KServe | Layer 4 (off) | Apache-2.0 | `licenses/Apache-2.0.txt` | Model serving / inference |

### Helper / demo images

| Component | Version | License (SPDX) | Full text | Notes |
|---|---|---|---|---|
| amazon/aws-cli | 2.31.13 | Apache-2.0 | `licenses/Apache-2.0.txt` | Bucket-init helper |
| traefik/whoami | 1.10.3 | MIT | `licenses/MIT.txt` | Software-delivery demo app |
| **Trivy** | **0.58.2** (`aquasec/trivy`) | **Apache-2.0** | `licenses/Apache-2.0.txt` | **Software deploy security scanner.** os-ui launches ONE Job per deploy request (`os-ui/tabs/software/lib/scan-trivy.ts`) and maps its JSON onto the Builder review card: dependency vulnerabilities from the app's manifests/lockfiles + committed secrets. **Deployed image only** — no Trivy source is vendored into `os-ui` and nothing links against it; it is a separate short-lived process (mere aggregation). `sast` stays *not run*: Semgrep's engine is LGPL-2.1 and is **not** on `licenses/allowed-licenses.txt`. |
| Docker-in-Docker (dind) | 27 | Apache-2.0 | `licenses/Apache-2.0.txt` | CI build sidecar (Moby/Docker) |

### Model serving

> Inference runs entirely on **STACKIT AI Model Serving** (a managed, EU-sovereign
> API — three-tier set: reasoning `Qwen/Qwen3-VL-235B-A22B-Instruct-FP8`,
> standard/worker `openai/gpt-oss-20b`, embeddings `Qwen/Qwen3-VL-Embedding-8B`).
> No model engines or model weights are bundled or redistributed by this project;
> LiteLLM calls the managed API. On kind/local the bundled `mock-model` (our own
> Apache-2.0 image) serves deterministic offline embeddings only.

### Referenced but NOT bundled

| Component | Version | License (SPDX) | Notes |
|---|---|---|---|
| MinIO | digest-pinned | AGPL-3.0 | **Local dev-only S3 stand-in.** AGPL — **never bundled/redistributed** in the product. SeaweedFS (Apache-2.0) is the bundled/air-gap object store. Full text kept for transparency at `licenses/AGPL-3.0.txt`. |

> Our own images (`sovereign-os/*`: mock-model, sample-agent, poet-agent,
> haystack-retriever, query-tool, dbt, dagster, superset, egress-proxy, web-fetch,
> os-ui, ci-builder) are **Borek Data Ventures UG** code under
> **Apache-2.0** (`LICENSE`) and carry SPDX headers.

---

## Copyleft source availability

- **git (GPL-2.0-only)** — the unmodified Alpine package in the git-http, git-daemon and backup-tools images, run as a
  separate program (reviewed exception in `licenses/exceptions.json`). Upstream source and the written offer for the
  air-gap bundle are recorded in `licenses/source-offer.md`.

The air-gap bundle (per `stackit/packaging.md`) ships `sbom.cdx.json`, this manifest,
and the whole `licenses/` directory alongside the mirrored images.

## Release process

On every release:

1. `scripts/license-check.sh --update-sbom` — regenerate `sbom.cdx.json` (syft) and run
   the licence gate (`licenses/policy.json`; see "Licence policy" above).
2. Reconcile this manifest + `licenses/components.tsv` with any added/updated/removed
   components and pinned versions in `Chart.yaml` / `values.yaml`.
3. Add the full license text for any **new** license under `licenses/`, and the
   component's NOTICE (if it ships one) under `licenses/notices/`.
4. Update `licenses/source-offer.md` if a copyleft component's pinned version changed.

The CI gate (`.github/workflows/license-gate.yml`) fails the build if a component's
license is never allowed by `licenses/policy.json` (AGPL, source-available), is copyleft without a reviewed
exception, is unknown without a reviewed exception, or lacks an attribution entry.
