<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# `deploy/` — STACKIT Mode B deploy automation

One-command provision + GitOps deploy of the **full managed STACKIT stack
(Mode B)** for the Sovereign Agentic OS: **Terraform** provisions the cloud
edges once; **Argo CD** (app-of-apps) keeps the cluster matching git forever.
After bootstrap, deploying = committing, and adding a layer = adding its
subchart/Application.

> Mode B points the heavy stateful backends at **STACKIT managed services**
> (Object Storage, PostgreSQL Flex, OpenSearch) and routes LiteLLM to **STACKIT
> AI Model Serving**. The default product is **Mode A** (everything bundled,
> scales to zero). **In Mode B the managed services bill 24/7 and do NOT scale
> with `sleep`/`wake` — only the worker nodes do.**

## Tree

```
deploy/
  Makefile                     # stackit-up/down, sleep/wake, sync, images, validate
  README.md                    # this file
  terraform/                   # STACKIT infra (stackitcloud/stackit provider, pinned ~>0.99)
    versions.tf                #   provider + auth + state guidance
    variables.tf  *.tfvars.example
    ske.tf                     #   SKE cluster (Cilium = platform default) + node pool + kubeconfig
    objectstorage.tf           #   buckets + credentials group + access key
    postgresflex.tf            #   PostgreSQL Flex instance + app user
    opensearch.tf              #   managed OpenSearch instance + credential
    secretsmanager.tf          #   Secrets Manager instance + writer/reader users
    modelserving.tf            #   AI Model Serving auth token + base URL
    dns.tf                     #   DNS zone + per-subdomain A records
    registry.tf                #   Container Registry URL (manual — see Gaps)
    outputs.tf                 #   every endpoint/credential the chart needs
  argocd/
    bootstrap/                 # install Argo CD itself (pinned, kustomize)
    project.yaml               # AppProject "sovereign-os"
    app-of-apps.yaml           # root Application -> apps/
    apps/                      # one Application each, by sync wave:
      00-ingress-nginx 01-cert-manager 02-external-secrets
      03-external-secrets-config 04-cloudnative-pg 05-velero 06-keda
      10-sovereign-agentic-os  #   the umbrella chart (wave 5, last)
    secrets/                   # ClusterSecretStore + ExternalSecrets (the k8s
                               #   Secrets the chart references by name)
  scripts/
    render-values.sh           # fill overlay/Argo REPLACE-… tokens from tf outputs
    publish-images.sh          # build+push bespoke images by digest (dry-run default)
    push-secrets.sh            # write credential values into Secrets Manager (dry-run default)
```

## Prerequisites (one-time, go-live)

- A **STACKIT project** (region **EU01**) and a **provisioning-scoped SA key** at
  `stackit/sa-key.json` (gitignored) — Editor on the project.
- `terraform` **or** `opentofu`, `kubectl`, `helm`, `argocd`, `jq`, and a
  container build tool (`docker`/`nerdctl`) on PATH.
- The **Container Registry created out-of-band** (the provider has no resource —
  see Gaps); pass its URL via `container_registry_url`.
- The **cost guard ARMED first** (`stackit/cost-monitor.conf`
  `HARDSTOP_ARMED="true"`; confirm the alert/hard-stop limits suit Mode B).
- `cp terraform/terraform.tfvars.example terraform/terraform.tfvars` and fill
  `project_id`, `dns_name`, sizing.

## One-command deploy — what `make stackit-up` does (ordered)

`make stackit-up CONFIRM=I-ACCEPT-MODE-B-COSTS`:

1. **`terraform apply`** — provisions SKE (Cilium) + node pool, Object Storage
   (buckets + credential), PostgreSQL Flex (+ user), managed OpenSearch
   (+ credential), Secrets Manager (+ writer/reader users), the AI Model Serving
   token, and the DNS zone + records. *(First real spend.)*
2. **`make kubeconfig`** — writes `kubeconfig.yaml` (gitignored, mode 600) from
   the `kubeconfig` output; `kubectl get nodes` shows the pool Ready.
3. **`make render`** — `render-values.sh` fills the `REPLACE-…` endpoint/registry/
   DNS tokens in `values.stackit-managed.yaml` + the Argo manifests from
   `terraform output`.
4. **(operator) `make secrets ARGS=--write`** — `push-secrets.sh` writes the
   credential values into Secrets Manager (object-storage, postgres, opensearch,
   AI token). External Secrets reads them in.
5. **`make argocd-install`** — installs Argo CD (pinned) via `kubectl apply -k
   argocd/bootstrap`.
6. **`make bootstrap`** — applies the `AppProject` + `app-of-apps.yaml`. Argo CD
   then reconciles, by **sync wave**:
   - wave 0: ingress-nginx (provisions the LB + public IP), cert-manager
   - wave 1: External Secrets Operator, CloudNativePG, Velero, KEDA
   - wave 2: the ClusterSecretStore + ExternalSecrets (materialise the Secrets)
   - wave 5: the **Sovereign Agentic OS umbrella chart** (Mode B overlay)
7. After ingress has its LB IP: **`make dns`** patches the DNS A records to it;
   cert-manager issues TLS. Then smoke-test (go-live-stackit.md §9).

`make stackit-down CONFIRM=…` reverses it: Argo prunes workloads, then
`terraform destroy` removes infra (managed services included — they survive a
bare cluster delete, so always destroy via Terraform).

## `make sleep` / `make wake` — the 08:00–20:00 window

`make sleep` scales the SKE node pool to **0** (`terraform apply -var
node_pool_min=0 -var node_pool_max=0`); `make wake` restores it from
`terraform.tfvars`. Drive them from a scheduled task (wake 08:00, sleep 20:00).
**Only the worker-node line shrinks** — Postgres Flex, OpenSearch, the SKE
control-plane fee, the load balancer and storage keep billing overnight.

## Rough Mode B monthly cost (EU01, June 2026 list prices)

Assumed demo sizing: **3 worker nodes × ~4 vCPU / 32 GB**. Estimated lines
(*est.*) need confirming in the STACKIT calculator.

| Item | 24/7 | 08:00–20:00 |
|---|---|---|
| SKE control plane (cluster mgmt fee) | €75 | €75 |
| Worker nodes (3 × 4 vCPU / 32 GB) | €415 | ~€210 |
| Load balancer (ingress) | €12 | €12 |
| Block storage (~300 GB PVs) | €15 | €15 |
| Object storage (~100 GB @ €0.006/GB) | €1 | €1 |
| Managed PostgreSQL Flex (small/med) *est.* | €80–150 | €80–150 |
| Managed OpenSearch (smallest viable) *est.* | €150–300 | €150–300 |
| AI Model Serving (usage-based) *est.* | €20–100 | €20–100 |
| Container Registry *est.* | €5–15 | €5–15 |
| **Total** | **≈ €770–1,100 / mo** | **≈ €570–890 / mo** |

The 8–8 window saves ~€200/mo (compute only). **A 24/7 Mode B demo can brush the
€1000 hard-stop** — raise the limit deliberately or run the window. (For bigger
overnight savings, Mode A scales almost entirely to zero — at the cost of
self-managing the databases.)

### Single-node Mode A sizing (central Trino) — decided 2026-06-29

The verified Mode A path runs everything on **one** node. With **central Trino**
added (a memory-hungry, always-on JVM) the single node is sized to **`m3i.16`** — a
**memory-optimized, gen-3 Intel** flavor (~16 vCPU / **128 GB**; confirm the exact
vCPU/RAM/price in the STACKIT calculator at provisioning). Memory-optimized gives
Trino's heap headroom; gen-3 Intel gives the concurrent-query throughput without an
old-gen tradeoff. We deliberately do **not** add a dedicated 2nd Trino node:
cross-node pod networking on SKE-in-an-SNA is broken (verified 100% cross-node
loss), so one bigger box is the only viable topology. Price the flavor in the
STACKIT calculator and keep it under the **€1000 cost-alert hard-stop**; the node
still pauses to ~0 off-hours via `make stackit-sleep`. The **user provisions**
(`m3i.16`) — we never provision STACKIT.

## `values.stackit-managed.yaml` wiring (Terraform output → overlay)

`render-values.sh` substitutes (endpoints/registry/DNS — never secrets):

| Overlay token | Terraform output | Goes to |
|---|---|---|
| `REPLACE-postgres-flex-host` | `postgres_host` | `postgres.external.host` |
| `REPLACE-opensearch-host` | `opensearch_host` | `opensearch.external.host` |
| `REPLACE-model-serving-base-url` | `model_serving_base_url` | `litellm…api_base` |
| `REPLACE-REGISTRY` | `container_registry_url` | every bespoke `image.repository` |
| `REPLACE-DNS-NAME` | `dns_name` | `ingress.hosts.*` |
| `REPLACE-*-DIGEST` | (publish-images.sh) | bespoke `image.tag` (`<ver>@sha256:…`) |
| `REPLACE-chat/embed-model-id` | (operator picks) | LiteLLM model ids |

Object-storage endpoint is fixed (`object.storage.eu01.onstackit.cloud`).
**Secrets** (S3 keys, PG/OpenSearch passwords, AI token, registry pull-secret)
go to Secrets Manager via `push-secrets.sh`; the chart receives them as k8s
Secrets created by the **ExternalSecrets** in `argocd/secrets/`
(`object-storage-credentials`, `postgres-credentials`, `opensearch-credentials`,
`stackit-ai-model-serving-key`, `velero-credentials`, `registry-pull-secret`).

Image digest pinning: the chart templates render `repository:tag`, so we set
`repository` to the registry path and `tag` to `<ver>@sha256:<digest>` — a valid
OCI reference where the digest is authoritative (no chart-template change).

## Local validation (no STACKIT calls)

```
make -C deploy validate          # terraform init -backend=false + validate + fmt -check
kubectl apply --dry-run=client -f deploy/argocd/            # Applications well-formed
# kind app-of-apps flow: bring up Argo CD on a throwaway kind cluster and apply
# app-of-apps pointed at this repo; confirm the child Applications appear.
```

## Go-live checklist (the cost-gated steps this build stops short of)

Full runbook: `stackit/go-live-stackit.md`. In short: **arm the cost guard** →
put secrets in Secrets Manager → `terraform plan`/`apply` → push images →
`render` → bootstrap Argo CD → DNS/TLS → smoke test → day-2 (sleep/wake,
backups, rollback = `git revert`).

## Gaps / flags

- **Container Registry is NOT a Terraform resource** (verified, provider 0.99/
  0.100). Create it once in the portal/CLI and pass `container_registry_url`.
  `registry.tf` only surfaces the URL.
- **Cilium is not Terraform-selectable** — it is the SKE platform default CNI.
  The resource exposes no CNI knob; the chart's default-deny NetworkPolicies ride
  on top.
- **AI Model Serving**: only the auth **token** is Terraform-managed; the
  inference endpoint is the fixed base URL above, and the chat/embed **model ids**
  are picked by the operator (`stackit ai-model-serving models`).
- **Chart-side external wiring is a follow-up**: the overlay disables the bundled
  backends, sets `*.external.*`, the registry/digest image refs, `ingress.hosts`,
  and `global.imagePullSecrets` — but several of these are not yet *consumed* by
  the chart templates (no template reads `postgres.external`/`opensearch.external`,
  there are no `Ingress` templates, and `imagePullSecrets` is not wired in). The
  image-digest overrides and the External-Secrets-backed Secrets ARE consumed and
  correct. The infra (Terraform), the Secrets pipeline (Secrets Manager → ESO →
  k8s Secrets), the registry/digest plumbing, and the GitOps flow are complete and
  validated; finishing the per-component external-backend + ingress templating is a
  `charts/` task, intentionally out of scope here (this build does not edit chart
  templates). The overlay is written so that work is a pure consume-the-values step.
- **Node flavor / OpenSearch plan / PG storage-class names** are catalog-driven;
  the defaults are sensible but confirm exact names in the STACKIT catalog before
  `apply` (flagged inline in `variables.tf`).
