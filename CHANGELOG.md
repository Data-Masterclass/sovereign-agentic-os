<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Changelog

All notable changes to **Sovereign Agentic OS** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is **pre-beta** software: APIs, values, and surfaces may change between
`alpha`/`beta` pre-releases without notice.

## [Unreleased]

### Governance

- **Open-source Git governance.** Added `GOVERNANCE.md` (roles, lazy-consensus
  decision-making, how to become a maintainer, SemVer release process),
  `SECURITY.md` (private vulnerability reporting via GitHub Security Advisories +
  `security@datamasterclass.com`, coordinated disclosure), `.github/CODEOWNERS`
  (the `@Data-Masterclass/maintainers` team owns the tree), a pull-request
  template, and YAML issue forms (`bug_report.yml`, `feature_request.yml`,
  `config.yml` — blank issues disabled, security routed to advisories).
- **CI workflow** (`.github/workflows/ci.yml`) running on pull requests to `main`
  with stable, required-check job names: `build` (os-ui), `helm-lint`, and
  `secret-scan` (gitleaks); actions pinned to commit SHAs.
- **Branch protection** on `main` (public repo): PR required with 1 approval +
  CODEOWNERS review + green CI, **signed commits required**, linear history, and
  admin self-merge bypass for the sole maintainer.

## [0.2.0-alpha.2] — 2026-06-29

Headline: **four golden paths** become demonstrable end-to-end, the in-cluster
database moves to a **plain Postgres** that survives STACKIT's SKE-in-an-SNA
internal-DNS wall, startup is **orchestrated** so the node no longer OOMs, and
the bare zone **apex** now serves the OS UI.

### Added

- **Four golden paths** (agent / science / software / connections).
  - **Agent** — a Sales Assistant vertical slice: `AGENT.md` + `MEMORY.md`
    shipped as a versioned ConfigMap, a supervisor running in the OS UI over the
    governed LiteLLM + OPA + Langfuse spine, with a scoped key and approval-gated
    high-stakes tools (CRM write, knowledge certify).
  - **Science** — churn model as a governed tool (`predict`), a Dagster
    retrain pipeline (off by default), MLflow-tracked re-train → re-certify loop.
  - **Software** — per-app builds in the Software tab (Forgejo Actions → registry
    → Argo CD → subdomain), with an optional Harbor registry (off by default).
  - **Connections** — manually-credentialed API/MCP/Database/SaaS connections
    whose capability profile compiles into per-connection OPA policy data; the
    credential lives only in Secrets Manager (External Secrets, opt-in). Worked
    examples: Notion MCP + Salesforce API, allowlisted on the egress proxy.
- **Apex route.** `ingress.hosts.osUIApex` adds a second os-ui Ingress on the
  bare zone apex (e.g. `agentic.datamasterclass.com`), with its own TLS, so the
  apex serves the OS UI instead of 404ing next to `os.<zone>`. Set in the
  self-hosted overlay.
- **PriorityClasses** (`sovereign-os-infra` / `sovereign-os-app`) protecting the
  data layer under memory pressure; gated so local-kind still admits every pod.

### Changed

- **Plain in-cluster Postgres is now the default** (`postgres.engine: plain`,
  `cnpg` opt-in). A self-contained StatefulSet on the official `postgres` image
  that never talks to the Kubernetes API — fixing the **STACKIT SKE-in-an-SNA
  internal-DNS wall** that hung CloudNativePG's API-dependent bootstrap. It
  reproduces the CNPG path exactly (same `pg-rw`/`pg-ro`/`pg-r` Services, app DB
  + per-`extraDatabases` role/db/grants) so every consumer connects unchanged.
- **Orchestrated startup — no OOM.** Argo CD **sync-waves** (infra 0 / middleware
  1 / apps 2) stage the rollout, **resource requests** add memory backpressure,
  and **PriorityClasses** evict app pods before the DB — replacing the ~30-pods-
  at-once boot that spiked > 32 GB and OOMKilled LiteLLM / errored OpenMetadata.
  Both database engines (plain StatefulSet **and** CNPG cluster) carry the wave-0
  annotation, infra priority, and bumped memory requests/limits.

### Fixed

- **NetworkPolicy DNS egress on `:8053` — the SKE-in-an-SNA root cause.**
  Gardener/SKE runs CoreDNS listening on **8053** (the `kube-dns` Service remaps
  `53 → 8053`), and Calico enforces egress **post-DNAT**, so a policy that only
  allowed port 53 silently dropped every pod's DNS. `allow-dns-egress` now
  permits UDP/TCP **8053** alongside 53, fixing the all-night cluster-internal
  resolution failures (`pg-rw` and internal-API i/o timeouts) on both the
  multi-node and single-node STACKIT SKE deploys. With this fix plus the default
  **plain in-cluster Postgres**, the stack was validated **GREEN on live
  STACKIT** — Postgres up, all 5 governed tools reachable, and the Components
  API healthy.
- **OS UI console links** no longer point at `localhost` when deployed: each
  console URL derives from the matching ingress host (`soa.consoleUrl`); tools
  with no public host hide their "Open" link.

## [0.2.0-alpha.1] — 2026-06-28

Headline: the OS UI becomes a **teaching-ready, multi-tenant workspace**, the
**Admin Console is merged natively into the OS UI** (one app, one image), and a
full **STACKIT (EU) deploy path** lands with both a self-hosted (Mode A) and a
managed-services (Mode B) topology.

### Added

- **Teaching-ready multi-tenant OS UI.**
  - Identity & sessions: sign-in page, cookie session, auth/me/login/logout API
    routes, and route-guarding middleware.
  - Tenancy: per-user **domains** as the tenant scope, plus **user management**
    (users page + users API).
  - **Artifact lifecycle** `Personal → Shared → Certified` with admin-gated
    promotion. Certified artifacts publish cross-domain into a **Marketplace**;
    other users "add" a Certified artifact, which drops a scoped
    `certified-copy` into their own workspace. The server-side scoping rules are
    the security boundary regardless of backing store.
  - **In-app authoring** surfaces for datasets, dbt transformations, Cube
    metrics, dashboards, agents, and knowledge docs — each created and versioned
    as a lifecycle artifact.
- **STACKIT deploy automation** (`deploy/`):
  - Terraform for an SKE cluster + DNS zone, and (Mode B) STACKIT managed
    Postgres Flex, OpenSearch, Object Storage, Secrets Manager, AI Model
    Serving, and Container Registry.
  - Argo CD **app-of-apps** GitOps bootstrap (ingress-nginx, cert-manager,
    external-secrets, CloudNativePG, Velero, KEDA) and the umbrella app.
  - `deploy/Makefile`, `render-values.sh`, `publish-images.sh`,
    `push-secrets.sh`, and example `terraform.tfvars.example` / `.env.stackit.example`
    (placeholders only; real state/creds are git-ignored).
  - A local **`deploy/stackit` control CLI** + launchd scheduler
    (`on`/`off`/`deploy`/`destroy`/`urls`/`open`/`schedule`) to drive cost
    windows from a workstation.
- **Mode A (self-hosted on SKE)** topology: `enable_managed_backends=false` runs
  every backend in-cluster from the self-contained chart and pauses fully with
  the node pool. New `values.stackit-selfhosted.yaml` overlay.
- **Single-node STACKIT install guide** (`docs/stackit-deployment-guide.md`) —
  the **recommended, end-to-end-verified** path: one `g2i.8` node (8 vCPU / 32 GB)
  in a single AZ, node pool pinned `min=1/max=1`, the full self-contained L1–L3
  stack (~14 GB) bundled in-cluster, scaled to 0 off-hours. Captures every issue
  hit on the first real deploy and the validated config that fixes each.
- **Chart Mode-B production templating**: a per-tool **Ingress** template
  (`ingress.yaml`, off unless `ingress.enabled=true`), external-backend wiring,
  `imagePullSecrets`, and an os-ui ServiceAccount/Role.
- **Licensing/governance**: Contributor License Agreement (`CLA.md`) + CLA CI
  workflow, `TRADEMARKS.md`, and brand trademark-lockup assets.

### Changed

- **Admin Console merged into the OS UI.** Its functionality now lives natively
  as the **Platform → Components** surface. The standalone `admin-console` image
  is **deprecated and off by default** (`adminConsole.enabled=false`); the OS UI
  image now builds from the repo root and bakes in the component docs.
- **Entity corrected to Borek Data Ventures UG (haftungsbeschränkt)** across SPDX
  headers, `LICENSE`/`NOTICE`, and scripts (previously "Data Masterclass GmbH").
- OS UI branding/title refresh; docs (the end-user Guide + PDF, getting-started,
  component docs) updated for OS UI v1.0 and the Components surface.
- `values.stackit-managed.yaml` expanded for the Mode-B managed topology.

### Fixed

- Mode A binds bundled stateful components against the **SKE default
  storageClass** (empty class) instead of a hard-coded class.
- Production chart-templating corrections for external backends, image pull
  secrets, and Ingress gating so the local/Mode-A path renders unchanged.
- **STACKIT Terraform hardened from the first real SKE deploy:**
  - Kubernetes default raised to **`1.34`** (the old `1.31` is no longer offered
    by SKE and is rejected at apply).
  - Default machine flavor **`g2i.8`** (8 vCPU / 32 GB; `c1.4` is deprecated).
  - SKE **cluster name truncated to ≤ 11 chars** (`substr(replace(name,"-",""),0,11)`)
    — SKE rejects longer names.
  - New **`network.tf`** creates a routed `/24` so the cluster can attach to the
    project's **STACKIT Network Area (SNA)** (`stackit_ske_cluster.network`).
  - **Kubeconfig `expiration = 2592000`** (30 days) — the ~1 h default expired
    mid-deploy and corrupted installs.
  - **Terraform defaults are now the verified single-node setup** — a plain
    `tofu apply` yields one **`g2i.8`** node in a **single AZ (`eu01-1`)**, node
    pool pinned **`min=1/max=1`**, Kubernetes **`1.34`**. Multi-node and Mode-B
    stay available via explicit tfvars overrides but are now **known-blocked**
    (see Known limitations). (Multi-AZ requires `max ≥ #AZs`.)
- **OS UI console links no longer hard-code `localhost` on a real deploy.** The
  os-ui chart template now **derives every browser-reachable console URL from the
  ingress host** as `https://<tool>.<domain>` (new `soa.consoleUrl` helper) when
  `ingress.enabled` — so Superset/Langfuse/Forgejo/Argo CD/OpenMetadata links in
  the deployed UI point at the public ingress, not `http://localhost:8088` etc.
  Tools with no public ingress host (e.g. Dagster) resolve to an empty URL and the
  UI **hides their "Open" link** instead of linking to an unreachable localhost.
  Local-kind keeps the port-forward defaults.
- **`global.profile: local`** is required for the self-contained overlay so the
  chart generates the bundled credential Secrets (`profile: stackit` skips them,
  causing `CreateContainerConfigError` on ~17 pods). The private-registry pull
  secret is attached to the namespace **ServiceAccounts** (the `global.imagePullSecrets`
  map/string formats clash between bespoke and subchart pods). Bespoke images must
  be built **`linux/amd64`** (ARM images crash on SKE with `exec format error`).

### Known limitations / scaffolded

- The **in-app authoring backends are partly scaffolded.** Authoring produces
  **draft specs/plans stored as lifecycle artifacts** (with full Personal/
  Shared/Certified scoping enforced server-side); **compiling or executing** those
  drafts into the live dbt / Cube / LangGraph (and software scaffold → CI →
  GitOps) runtimes is **draft-for-review**, not yet a one-click live build.
- Artifact/user **persistence** is an authoritative in-process cache with
  **best-effort OpenSearch write-through** — durable when OpenSearch is reachable,
  in-memory otherwise (so the teaching flows work with no live cluster).
- STACKIT Terraform now defaults to the validated single-node values
  (`kubernetes_version_min` `1.34`, `g2i.8`, single-AZ node pool). Still
  **confirm flavor/plan names and sizing in the STACKIT catalog before `apply`**
  — they change per project/region.
- **BLOCKER — cross-node pod networking is broken on SKE-in-an-SNA; single node
  is the only verified path.** On an SKE cluster attached to a STACKIT Network
  Area (SNA), **a pod scheduled on a node *without* a CoreDNS replica cannot reach
  DNS or any pod on another node** — verified: same-node traffic works, cross-node
  is **100% loss** ("no servers could be reached"). This — not the SNA's external
  resolvers — is the real root cause that took down the Postgres-backed components
  on the first multi-node deploy: **CloudNativePG's init pod landed on the bad
  node, could not resolve, and the stateful bootstrap cascaded.** A **single node
  sidesteps it entirely** (no cross-node traffic), which is why single-node is now
  the default and only-verified topology. Multi-node HA and Mode-B managed are
  therefore **known-blocked** until STACKIT confirms cross-node overlay.
  - *Correction to the earlier note:* this was first framed as an **"SNA DNS"**
    problem — the SNA's `8.8.8.8` resolvers "couldn't resolve the internal SKE API
    hostname". That was a **downstream symptom on the multi-node cluster**, not the
    root cause; the defect is the **cross-node overlay dataplane**, and it
    disappears on a single node. Still run `nslookup kubernetes.default` from a
    throwaway pod before deploying (it just works on one node); if it fails there,
    the **SNA itself** is misconfigured — open a STACKIT support ticket.

## [0.1.0-alpha.1]

Initial public pre-release: the umbrella Helm chart (Layers 1–4 + a
secure-by-default baseline), the OS UI front door, the Apache-2.0 licensing
baseline (LICENSE/NOTICE, third-party manifest, SBOM), and the end-user guide.

[0.2.0-alpha.2]: https://github.com/Data-Masterclass/sovereign-agentic-os/releases/tag/v0.2.0-alpha.2
[0.2.0-alpha.1]: https://github.com/Data-Masterclass/sovereign-agentic-os/releases/tag/v0.2.0-alpha.1
[0.1.0-alpha.1]: https://github.com/Data-Masterclass/sovereign-agentic-os/releases/tag/v0.1.0-alpha.1
