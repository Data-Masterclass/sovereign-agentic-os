# Cloud Install: Sovereign Agentic OS on GKE / EKS / AKS — Design Report

Date: 2026-07-20 · status: advisory (decisions pending). Goal: the simplest, most reliable one-Helm-install on managed Kubernetes (GKE/EKS/AKS), auto-wired to each platform's storage + LLM serving, keyless (no static creds), avoiding a separate managed Postgres where possible — plus a super user-friendly install guide/wizard.

## 0. What the system already is (the good news)
The umbrella chart already has a **bundled↔external abstraction**, so cloud overlays are a *values exercise, not a re-architecture*:
- `_helpers.tpl` indirection (`soa.pgHost`, `soa.s3Endpoint`, `soa.opensearchUrl`, `soa.storageClass`) returns the in-cluster service when a backend is `enabled`, else a required external endpoint — exactly the seam a per-cloud overlay flips.
- **`values.stackit-managed.yaml` is the template to copy** — it already disables bundled backends and points at managed endpoints + rewrites the LiteLLM model_list.
- **Postgres consolidation is already built** (`postgres.extraDatabases` = one server, many DBs/roles + a reconcile hook). Two engines exist: `plain` (default; StatefulSet, never calls K8s API — chosen because CNPG's initdb hangs on STACKIT's SNA networking) and `cnpg` (CloudNativePG, opt-in). **That STACKIT constraint does NOT apply to GKE/EKS/AKS**, so CNPG works there — the pivot for the Postgres recommendation.
- LiteLLM is the sole LLM path; tiers are aliases `sovereign-reasoning` / `sovereign-default` / `sovereign-embed`. `os-ui/lib/agents/routing.ts` already classifies `azure|bedrock|openai-compatible|stackit|self-hosted`.
- **Keyless cloud identity is already implemented** for the external-warehouse feature (`lib/connections/warehouse/providers/`): BigQuery via Workload Identity, Glue via IRSA, Fabric via Entra token. Same principle now applies to the platform's own storage plane.
- An install wizard already exists (`install.sh`, interactive bundled/external prompts + `--defaults`). The `sos` CLI is currently a governed MCP client (not yet an installer).

**Datastore reality:** every Postgres consumer needs only a DB+role on a shared server. But **Langfuse (ClickHouse + Valkey + blob)** and **OpenMetadata (OpenSearch)** need extra datastores regardless — no Postgres decision makes the platform single-datastore; those stay bundled or move to managed per overlay.

## 1. Postgres — avoid the separate managed service ✅
**Recommendation: chart-bundled CloudNativePG (CNPG) as the default on GKE/EKS/AKS.** It's the only option that is simultaneously portable (one identical abstraction on all three clouds), sovereign (data + control plane in-cluster), and a genuine single `helm install`.
- CNPG = Apache-2.0, CNCF Sandbox (accepted Jan 2025) — the one maturity caveat to state honestly. HA via streaming replication + automated failover; PITR/WAL to S3/GCS/Azure Blob via the **Barman Cloud plugin** (the in-tree `barmanObjectStore` field is deprecated 1.26 / removed 1.30 — wire the plugin). One `Database` CR per DB (owner role + declarative extensions incl. pgvector) — maps onto the existing `extraDatabases`.
- **Cloud-durable defaults the chart must ship:** 3 instances + zone anti-affinity/topology spread (a zonal disk can't cross-AZ-attach → HA comes from replicas-in-other-AZs), a durable zonal CSI storage class, PDBs on, WAL archiving to the same bucket the lakehouse uses.
- **Managed opt-in** (when a customer mandates a provider SLA): GCP Config Connector `SQLInstance` / AWS ACK `DBInstance` / Azure ASO `FlexibleServer` / Crossplane — each needs its own operator + IAM, async 5–10 min provisioning, not sovereign. Supported via `postgres.enabled:false` + external host (helper already handles it).

## 2. Per-platform design (keyless identity + storage + LLM)
Common shape: one K8s ServiceAccount per component needing cloud APIs (min: `trino-sa`, `litellm-sa`, CNPG SA), each bound to a cloud identity with least-privilege roles, referenced via `serviceAccountName`. No static keys.

**GKE** — Identity: Workload Identity Federation (direct IAM binding, no intermediary GSA) → pods get ADC. Storage: **GCS + BigLake managed Iceberg REST catalog** (`iceberg.catalog.type=rest`, `security=GOOGLE`, keyless) or GCS+Polaris for portability. LLM: **Vertex AI via LiteLLM** (omit creds → ADC); tiers gemini-3.1-pro / gemini-2.5-flash / gemini-embedding-001; footgun: some LiteLLM versions need the `google/` prefix fallback under WI. Bootstrap: enable `aiplatform`/`storage`/`biglake` APIs, WI on cluster+nodepools (`GKE_METADATA`), GCS bucket, KSA+IAM bindings.

**EKS** — Identity: **EKS Pod Identity** (add-on + PodIdentityAssociation; IRSA fallback for cross-region Bedrock). Storage: **Glue Data Catalog + S3 + Trino Iceberg** (keyless via pod role) or S3 Tables (managed REST catalog). LLM: **Amazon Bedrock via LiteLLM** (boto3 → pod role, `aws_region_name` only); tiers `us.anthropic.claude-sonnet-4-5` / `us.amazon.nova-pro` / `amazon.titan-embed-text-v2`; **two big footguns:** newer models need cross-region inference profiles (`us.`/`eu.` prefixes) and **Bedrock model access must be enabled per model per region** or every call is AccessDenied. Bootstrap: Pod Identity add-on, 2 IAM roles (S3+Glue; Bedrock) + associations, S3 bucket (+Glue DB), enable Bedrock access.

**AKS** — Identity: **Microsoft Entra Workload ID** (AAD Pod Identity is deprecated — don't use); OIDC issuer + federated credential + KSA annotation + mandatory pod label `azure.workload.identity/use:"true"` (fail-close). Storage: **ADLS Gen2 (HNS on) + Polaris** via Trino native Azure FS (`azure.auth-type=DEFAULT`, MI client-id) keyless; OneLake only if already on Fabric. LLM: **Azure OpenAI via LiteLLM** (`enable_azure_ad_token_refresh:true` → DefaultAzureCredential, no key); tiers GPT-5.4 / GPT-5.4-mini / text-embedding-3-large. Bootstrap: OIDC+WI, user-assigned MI (≤20 FIC), federated creds, ADLS (HNS on) + role, Azure OpenAI resource + 3 deployments + Cognitive Services User.

**Embedding-dimension caveat:** changing the embedding model changes vector dim → forces an OpenSearch reindex. Set `retrieval.knnDimension` per overlay and pin one dimension per install.

## 3. Simplest reliable install flow
**Helm + a thin bootstrap** (not pure-Helm, not Terraform-heavy). Helm can't create a cluster, identity binding, bucket, or enable a managed LLM — those are the irreducible prerequisites (5–8 scriptable cloud API calls). Then **one `helm install -f values.<platform>.yaml`**. Mirrors the existing `install.sh` + `bootstrap-local.sh`.
**Fail-fast guards:** chart helpers already `required` external endpoints with clear messages; add a `helm test`/preflight that does one embed + one chat per tier + asserts the embedding dimension → reports the specific missing prerequisite.

## 4. Portability vs managed
Recommended default: **bundled CNPG + self-hosted lakehouse (Polaris); only the LLM is provider-managed** (nobody self-hosts frontier models on a starter install), wired keyless. The storage catalog is the one genuine per-platform choice (managed BigLake/S3 Tables for least-ops, or Polaris for cross-cloud portability).

## 5. Phased plan
1. **Chart:** make CNPG cloud-durable (Barman plugin + `ObjectStore` CR + HA defaults) + author `values.{gke,eks,aks}.yaml` (clone the STACKIT overlay: SA/identity annotations, storage/catalog wiring, LiteLLM model_list per provider, knnDimension) + SA templates.
2. **Trino catalog templates per cloud** (keyless `.properties`; reuse the prop-generation in `lib/connections/warehouse/providers/`).
3. **Bootstrap + preflight** — `deploy/cloud/bootstrap-<platform>.sh` (idempotent) + `helm test` doing one embed+chat per tier.
4. **Wizard (`sos install`) + step-by-step guide** — extend `install.sh` into `sos install` (per the CLI ROADMAP): asks cloud/project/region/bucket/LLM-tier/postgres-mode/domain (3–5 real inputs, defaulted + validated), runs bootstrap → helm install → preflight; write `docs/cloud-install-<platform>.md`; regen the guide PDF.

## 6. Decisions needed (5)
1. **Postgres default = bundled CNPG** (3-instance HA + Barman WAL) on cloud, managed as opt-in? (rec: yes)
2. **Lakehouse catalog default: Polaris everywhere (portable) vs managed BigLake/S3 Tables per cloud?** (rec: Polaris default, managed as a toggle)
3. **Confirm the LLM tier model pins** per cloud (§2 table) — drives cost + the pinned embedding dimension.
4. **Installer: extend `install.sh` to 3 clouds, or build `sos install` now** (Go)?
5. **Embedding dimension** — OK with a per-cloud default (e.g. 3072 GKE/AKS, 1024 EKS/Titan) vs one global?

**Key files:** `values.stackit-managed.yaml` (overlay template), `templates/postgres/cluster.yaml`, `templates/lakehouse/{trino,polaris}.yaml`, `_helpers.tpl`, `lib/connections/warehouse/providers/{bigquery,glue,fabric}.ts` (keyless props to reuse), `install.sh` + `scripts/bootstrap-local.sh`, `cli/sos/`.
