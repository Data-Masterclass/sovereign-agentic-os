<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Cloud install — GKE / EKS / AKS

The frictionless path to a running Sovereign Agentic OS on managed Kubernetes.
`sos install` is the wizard; the `bootstrap-<cloud>.sh` scripts here provision the
handful of prerequisites Helm cannot (identity, buckets, managed-LLM access).
Design authority: [`docs/research/cloud-install-gke-eks-aks.md`](../../docs/research/cloud-install-gke-eks-aks.md).

> Not live-verified. These scripts + the wizard are `go build`/`go vet`/`shellcheck`
> clean but have **not** been run against a real cloud cluster. Treat the first run
> on your account as the acceptance test; every step prints what it is doing and
> fails fast with the exact missing prerequisite.

## The flow (same on all three clouds)

```
sos install
  └─ collect 3–5 answers (cloud, account/region, bucket, postgres, LLM tiers, [domain])
  └─ render install.yaml         (admin answers only — NO secrets)
  └─ preflight                   (kubectl reachable, helm present, cloud CLI present)
  └─ deploy/cloud/bootstrap-<cloud>.sh   (keyless identity + bucket + managed LLM)
  └─ helm upgrade --install ... -f values.<cloud>.yaml -f install.yaml
  └─ health verify               (wait pods Ready; per-tier embed+chat -> `helm test`)
```

`sos install` is a **thin orchestrator**: it shells out to `kubectl`, `helm` and
these scripts — it never reimplements them. The scripts are idempotent
(check-before-create) and safe to re-run.

### Layering

`helm` merges, in order: chart `values.yaml` → per-cloud overlay
`values.<cloud>.yaml` (owned by the chart) → generated `install.yaml` (your
answers, applied last so they win). The overlay wires keyless identity, the
storage catalog and the LiteLLM `api_base` per provider; `install.yaml` carries
only the bucket, Postgres engine, `knnDimension`, the three tier model ids and
the optional ingress host.

## Keyless everywhere — no static keys

| Cloud | Identity mechanism | Storage | Managed LLM |
|-------|--------------------|---------|-------------|
| GKE   | Workload Identity Federation (KSA → IAM, direct) → ADC | GCS + BigLake/Polaris | Vertex AI |
| EKS   | EKS Pod Identity (add-on + associations; IRSA fallback) | S3 + Glue | Amazon Bedrock |
| AKS   | Entra Workload ID (OIDC issuer + federated creds) | ADLS Gen2 (HNS on) + Polaris | Azure OpenAI |

Each cloud binds three KSAs — `trino-sa`, `litellm-sa`, `cnpg-sa` — to a
least-privilege cloud identity. The bootstrap prints the exact annotations the
chart/overlay must set. Secrets are never written to files or logs.

## Per-cloud quickstart

The wizard sets the env for you. To run a bootstrap by hand from the repo root:

```bash
# GKE
SOS_PROJECT=my-proj SOS_REGION=us-central1 SOS_BUCKET=sovereign-os-my-proj \
  ./deploy/cloud/bootstrap-gke.sh

# EKS
SOS_ACCOUNT=111122223333 SOS_REGION=us-east-1 SOS_BUCKET=sovereign-os-acct \
  ./deploy/cloud/bootstrap-eks.sh

# AKS
SOS_SUBSCRIPTION=<sub-id> SOS_REGION=eastus SOS_BUCKET=sovereignosdata \
  ./deploy/cloud/bootstrap-aks.sh
```

Optional env (all three): `SOS_CLUSTER`, `SOS_NAMESPACE`, and the tier model ids
`SOS_LLM_REASONING` / `SOS_LLM_DEFAULT` / `SOS_LLM_EMBED`. See each script header.

## Footguns each script handles (from the report §2)

- **GKE** — Workload Identity must be on the cluster **and** every node pool
  (`GKE_METADATA`), or pods silently use the node SA. Some LiteLLM versions need
  a `google/` model prefix under WI. Uniform bucket-level access is set on.
- **EKS** — Bedrock model access is **per-model, per-region**; the script detects
  what is enabled and tells you exactly what to enable if a tier model is missing
  (it does not fake success). Newer models need `us.`/`eu.` cross-region inference
  profiles (already in the value pins). The Pod Identity add-on must exist before
  associations resolve.
- **AKS** — AAD Pod Identity is **deprecated**; this uses Entra Workload ID. The
  pod label `azure.workload.identity/use: "true"` is **mandatory** (fail-close).
  ADLS needs HNS **on**. Storage-account names are 3–24 lowercase-alnum (hyphens
  stripped). A Managed Identity allows ≤20 federated credentials.
- **All** — changing the embedding model changes the vector dimension → forces an
  OpenSearch reindex. `install.yaml` pins one `knnDimension` per install.

## kind / stackit

`--cloud kind` and `--cloud stackit` need no cloud bootstrap here: kind uses
`scripts/bootstrap-local.sh` + `values.local.yaml`, and stackit uses the existing
managed path + `values.stackit-managed.yaml`. The wizard skips the cloud
bootstrap for both and says so.

## Post-install verify

`helm --wait` plus the wizard's `kubectl wait --for=condition=Ready` confirms the
pods came up. The **per-tier embed + chat smoke test** (one embed + one chat per
`sovereign-reasoning`/`-default`/`-embed`, asserting the embedding dimension)
needs in-cluster network to reach LiteLLM, so it runs as `helm test` rather than
from the CLI:

```bash
helm test agentic-os -n agentic-os
```

This is intentionally a TODO for the offline CLI — flagged honestly at the end of
`sos install`.
