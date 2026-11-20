<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# The dev environment

## What it is for

Dev is a second, smaller copy of the Sovereign Agentic OS on STACKIT. Every merge to `main` is
deployed there automatically, and the smoke test and the acceptance journeys (WP-02) run against
it. Production gets a release only after the same commit was green on dev
([`ci-cd.md`](ci-cd.md)).

- **Separate.** Dev has its own STACKIT project, its own SKE cluster with one node, its own
  network and router, its own public IP and hostname (`os.dev.agentic.datamasterclass.com`), its
  own bucket and credentials, and its own Terraform state. Nothing peers with or routes to
  production.
- **Real.** It runs the same chart and the same pinned images as production, with smaller
  sizes. The only stand-in is an optional model stub, and only if you choose it.
- **Synthetic.** It holds only the Northpeak demo: the gold mart is generated in SQL, and the
  demo cast works in their demo domains. There is no production data, no real user list, and
  no production backup restored here.

## The flow

```
merge to main ─▶ ci.yml green ─▶ dev.yml: build os-ui:main-<sha> ─▶ deploy to dev ─▶ smoke + acceptance ─▶ dev-green
                                                                                                              │
                                    prod.yml (manual, owner approves) ─▶ release.sh: CI green? dev-green? ─────┘
                                                                         ─▶ tag the SAME digest ─▶ deploy prod ─▶ smoke
```

| Piece | File |
|---|---|
| Infrastructure (own state, own project) | `deploy/envs/dev/` |
| DNS: one record at Cloudflare, which serves the public zone (not Terraform; see below) | `tofu -chdir=deploy/envs/dev output dns_record` |
| Chart profile | `values.dev.yaml`, optionally `values.dev.model-stub.yaml` |
| Node budget for the capacity gate | `charts/sovereign-agentic-os/capacity.dev.yaml` |
| The env and context guard (dev can never reach prod) | `scripts/lib/env-guard.sh` |
| Deploy, release, smoke, rollback | `scripts/deploy.sh --env dev`, `scripts/release.sh --env dev`, `scripts/smoke-test.sh --env dev`, `scripts/rollback.sh --env dev` |
| Dev operations | `scripts/dev/{kubeconfig,bootstrap-secrets,platform,seed,reset,ci-kubeconfig}.sh` |
| CI | `.github/workflows/dev.yml`, `dev-nightly.yml`, `rollback.yml` |

**The guard.** Every deploy command first runs `scripts/lib/env-guard.sh`, and the env chooses
the kube context: prod uses `dmagenticos` and dev uses `dmagosdev`. The kubeconfig's
current-context is never used. The guard refuses each of these:

- a dev deploy with the production context name;
- a context whose API server is production's;
- a "dev" cluster without the marker `kube-public/sovereign-os-environment`
  (`environment=dev`), which `bootstrap-secrets.sh` writes;
- a prod deploy with the dev context, the dev API server, or a cluster marked dev.

The acceptance harness also refuses the production context (`E2E_KUBE_CONTEXT`). Tests:
`scripts/tests/env-guard.test.sh`.

*Optional hardening for production:* add the marker with `environment: prod` to the production
cluster. The guard then also refuses a production context that carries no marker. Nothing in this
change touches production.

## Sizing and cost

**Node: one `g2i.8` (8 vCPU, 32 GB).** It is the smallest flavour that passes the capacity gate
with `values.dev.yaml`:

```
node scripts/check-capacity.mjs --profile default --budget charts/sovereign-agentic-os/capacity.dev.yaml --values values.dev.yaml
  g2i.8:  CPU requests 49.2 %, memory requests 38.5 %, memory limits 83.1 %   -> ok
  m3i.4 (4 vCPU / 32 GB): CPU requests 99.5 %                                  -> FAILED
  g2i.4 (4 vCPU / 16 GB): CPU requests 99.5 %, memory limits 180 %             -> FAILED
```

The node's allocatable memory (26 GiB) is an estimate until the node exists. After the first
apply, replace it with the value from `kubectl --context dmagosdev describe node`.

**Monthly cost, list price, net EUR.** The sources are the STACKIT price list 1.0.45 of
2026-11-03
(<https://stackit.com/en/asset/download/37788/file/STACKIT_price_list.pdf?version=33>, linked from
<https://stackit.com/en/prices/cloud>) and the flavour sizes on
<https://docs.stackit.cloud/products/compute-engine/server/basics/machine-types/>. A month is
720 hours.

| Item | EUR / month |
|---|---|
| Worker `g2i.8` (0.409165 / h) | 294.60 |
| SKE cluster management (0.0995951 / h per cluster; no free tier listed) | 71.71 |
| Node disk, 100 GB, Premium-Performance 1 (7.32 per disk + 0.0654 per GB) | 13.86 |
| 3 PVCs (MinIO 10 Gi, repos 2 Gi, Postgres 2 Gi): 3 × 7.32 + 14 GB × 0.0654 | 22.88 |
| Public IPv4, ingress | 2.92 |
| Network Load Balancer, smallest SKU (10k connections; the SKU SKE picks is inferred) | 9.39 |
| Object storage, about 10 GB at 0.027 per GB (no base fee listed) | 0.27 |
| DNS: a record in the existing Cloudflare zone | 0 |
| **Infrastructure total** | **≈ 415.63** |
| Model tokens: LiteLLM caps the dev keys at 5 a week shared plus 1 a week per agent system | at most ≈ 22 at full use |

The total is about **€416 a month** for infrastructure, plus model spend capped at about €22.
GitHub-hosted runners are free for this public repository.

To save money, SKE hibernation (nights and weekends) stops the node line. It does not stop the
cluster fee, which STACKIT bills whether the cluster runs or is hibernated. Hibernation is not
configured here; it is the owner's call.

## Create (coordinator, after the owner confirms the cost)

**Prerequisites**

- A new STACKIT project for dev that is **not** in the production network area.
- A service account of that project only (Editor), with its key at `stackit/dev-sa-key.json`
  (gitignored).
- `cp deploy/envs/dev/terraform.tfvars.example deploy/envs/dev/terraform.tfvars`, then set
  `project_id`.

Every command is targeted. **Never run a plain `tofu apply`, in either root.**

```bash
D=deploy/envs/dev
tofu -chdir=$D init

# cluster, kubeconfig, ingress IP, bucket, credentials group, credential (6 resources)
tofu -chdir=$D plan \
  -target=stackit_ske_cluster.dev -target=stackit_ske_kubeconfig.dev -target=stackit_public_ip.ingress \
  -target=stackit_objectstorage_bucket.dev -target=stackit_objectstorage_credentials_group.dev \
  -target=stackit_objectstorage_credential.dev \
  -out=dev.tfplan                                  # review: "Plan: 6 to add, 0 to change, 0 to destroy"
tofu -chdir=$D apply dev.tfplan                    # applies exactly the reviewed, targeted plan
tofu -chdir=$D output dns_record                   # os.dev.agentic.datamasterclass.com  A  <ip>
```

**DNS is one manual record.** The public zone `datamasterclass.com` is served by **Cloudflare**.
This was checked on 2026-11-20: `dig NS datamasterclass.com` returns `*.ns.cloudflare.com`, and
`agentic.datamasterclass.com` is not delegated to STACKIT. So the STACKIT zone in
`deploy/terraform/dns.tf` is not the one the internet asks, and production's Terraform is not
touched. In Cloudflare, add `os.dev.agentic.datamasterclass.com`, type **A**, set to the IP
above, as **DNS only** (not proxied, so that cert-manager's HTTP-01 challenge reaches the
cluster).

**Then, on the dev cluster.** Each script refuses any other cluster.

```bash
scripts/dev/kubeconfig.sh                         # -> ~/.kube/dmagosdev.yaml, never ~/.kube/config
export KUBECONFIG=~/.kube/dmagosdev.yaml          # this shell only
scripts/dev/bootstrap-secrets.sh                  # marker + random secrets + private overlay
scripts/dev/platform.sh                           # ingress-nginx 4.11.3 on the dev IP, cert-manager v1.16.1
scripts/deploy.sh --env dev --from-registry main-<sha of origin/main>   # first install
scripts/dev/seed.sh                               # the Northpeak demo
scripts/dev/ci-kubeconfig.sh                      # the CI credential for the `dev` environment
```

Then complete the owner checklist in [`ci-cd.md`](ci-cd.md#owner-checklist-github-settings). It
sets `DEV_ENVIRONMENT_ENABLED=true`, after which every merge deploys to dev.

**What was checked offline (no credentials).**

- `tofu -chdir=deploy/envs/dev validate` passes. The production root is unchanged.
- `tofu plan -refresh=false` with a dummy token and a placeholder project lists exactly the 6
  resources above.
- The same plan with the production project id fails with `DEV_IN_PROD_PROJECT`.

## Dev model key

STACKIT AI Model Serving tokens carry no spend limit
(<https://docs.stackit.cloud/products/data-and-ai/ai-model-serving/how-tos/manage-auth-tokens/>),
so the budget is enforced in LiteLLM: `values.dev.yaml` caps the shared key at 5 a week and each
agent system at 1 a week. The token is still a separate one, in the dev project, so its spend
appears on the dev project's bill.

**The owner:**

1. In the STACKIT portal, open the **dev** project, then AI Model Serving, then **Create token**.
   Name it `sovereign-os-dev-litellm` and give it a lifetime of 90 days. Choose "Order
   fee-based" and copy the token: it is shown once.
2. On the operator machine:

   ```bash
   install -m 600 /dev/null ~/.sovereign-os-secrets/dev/stackit-model-key
   pbpaste > ~/.sovereign-os-secrets/dev/stackit-model-key     # or paste with an editor; never echo it
   ```

3. Run `scripts/dev/bootstrap-secrets.sh`. The key goes into the private overlay. If bootstrap
   ran earlier without a key, run `scripts/dev/reset.sh --yes-wipe-dev` instead, which rotates.

**Without a key**, deploy with the model stub: `DEV_MODEL=stub scripts/deploy.sh --env dev …`
(`values.dev.model-stub.yaml`). Every answer is then a labelled mock answer.

**The image pull token** for the private GHCR packages is a GitHub token with `read:packages`
only. Put it in `~/.sovereign-os-secrets/dev/ghcr-read-token`, and its login in `ghcr-read-user`.

## Secrets

`scripts/dev/bootstrap-secrets.sh` generates a random value for every credential in the chart's
`values.yaml`:

- the gateway master, UI and agent keys;
- the Langfuse keys, init user and core secrets;
- every Postgres role;
- ClickHouse, Valkey, MinIO and Polaris;
- the agent-runtime token.

It also generates the Northpeak cast with random passwords. These values are written to
**two places only**:

- `~/.sovereign-os-secrets/dev/values.dev.private.yaml` (mode 600; the directory is mode 700);
- the dev cluster: Secret `sovereign-os-dev-values`, which CI reads with
  `DEV_PRIVATE_VALUES=cluster`, plus `northpeak-seed-credentials`, `dev-backup-s3` and
  `registry-pull-secret`.

Nothing is printed, and nothing lands in git. `scripts/tests/dev-bootstrap.test.sh` renders the
chart with and without the overlay and fails if any credential is still the chart's literal.

## Reset (wipe and reseed)

```bash
KUBECONFIG=~/.kube/dmagosdev.yaml scripts/dev/reset.sh --yes-wipe-dev
```

The reset does the following:

1. Uninstalls the release and deletes the namespaces `agentic-os` and `agentic-apps`, with every
   PVC in them.
2. Generates new secrets.
3. Deploys `main-<origin/main sha>`.
4. Reseeds.

The cluster, the platform add-ons, the marker and the bucket stay. It takes about 30 minutes.

## Rollback

```bash
scripts/rollback.sh --env dev                 # one Helm revision back
scripts/rollback.sh --env dev --to <rev>      # the revision_before in a deploy record
```

From GitHub, use the `rollback` workflow with `env: dev`. A rollback restores manifests, not
data.

## Teardown (documented, never run by an agent)

The dev module has its own state, so a teardown can only reach dev resources. First delete the
Cloudflare record `os.dev.agentic.datamasterclass.com`.

```bash
tofu -chdir=deploy/envs/dev destroy \
  -target=stackit_objectstorage_credential.dev -target=stackit_objectstorage_credentials_group.dev \
  -target=stackit_objectstorage_bucket.dev -target=stackit_ske_kubeconfig.dev \
  -target=stackit_ske_cluster.dev -target=stackit_public_ip.ingress
```

Then:

- Set `DEV_ENVIRONMENT_ENABLED=false` (or delete it).
- Delete the `dev` Environment.
- Delete `~/.sovereign-os-secrets/dev/`.

The bucket must be empty before STACKIT deletes it.
