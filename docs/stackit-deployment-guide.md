<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Deploy to STACKIT — recommended: single node

This is the **primary, recommended way to run the Sovereign Agentic OS on STACKIT**: one
worker node, everything self-contained, in a single availability zone. It is the simplest
path that actually works end-to-end, and it is what a first-timer should follow.

> **TL;DR** — One **`g2i.8`** node (8 vCPU / 32 GB), a node pool pinned to **`min=1 / max=1`**,
> a **single AZ (`eu01-1`)**, Kubernetes **1.34**. Every backend (Postgres, OpenSearch,
> ClickHouse, Valkey, object storage) runs **in-cluster** from the self-contained chart
> (~14 GB) — nothing managed, nothing billing 24/7. Scale the node pool to **0** off-hours
> with `deploy/stackit off` and the whole stack pauses.

## Why single node (and why this is the only verified path)

| | Single node (this guide) | Managed (Mode B) | Multi-node HA |
|---|---|---|---|
| Status | **Recommended — the ONLY verified path** | **Known-blocked** | **Known-blocked** |
| Nodes | **1 × `g2i.8`** | ≥2 (multi-node) | 2–3 × sized |
| Backends | **bundled in-cluster** | STACKIT managed (bill 24/7) | bundled or managed |
| Pod overlay across nodes | **N/A (one node)** | ⚠ broken on SKE-in-an-SNA | ⚠ broken on SKE-in-an-SNA |
| Off-hours cost | **~LB + DNS only** (node pool → 0) | managed services still bill | LB + DNS |
| Best for | demos, teaching, evaluation | *(blocked — see Cautions)* | *(blocked — see Cautions)* |

A single node sidesteps the thing that **currently breaks every multi-node SKE-in-an-SNA
setup**: **cross-node pod networking is broken** — a pod scheduled on a node *without* a
CoreDNS replica cannot resolve DNS or reach pods on other nodes (verified: same-node traffic
works, cross-node is 100% loss / "no servers could be reached"). With one node there is **no
cross-node traffic**, so the problem cannot occur. The full self-contained L1–L3 stack fits
comfortably on one 32 GB node, so there is no reason to take on the multi-node networking risk.

> **The other two paths — managed services (Mode B) and multi-node HA — are wired in the repo
> (`deploy/`, `values.stackit-managed.yaml`) but are KNOWN-BLOCKED on STACKIT today**: both put
> work on more than one node, and cross-node pod overlay on SKE-in-an-SNA does not work (see
> [Cautions](#tips--cautions-stackit-specific)). Do **not** start there. Use single node until
> STACKIT confirms cross-node overlay for SKE-in-an-SNA.

---

## Step 0 — Prerequisites

On your machine (Mac/Linux):

- A **STACKIT project** in region **EU01 / Deutschland Süd** (note the **project ID**).
- A **service-account key** with provisioning roles (SKE + Object Storage + DNS), saved to
  `stackit/sa-key.json` (gitignored). This is the gate for any live deploy.
- **`tofu`** (OpenTofu) **or** `terraform` on PATH.
- **`kubectl`**, **`helm`**, and **`docker buildx`** (a container builder that can target
  `linux/amd64` — see the ARM caution).
- A **domain you control** (you will set A-records for the apex + a wildcard).

Copy the env + tfvars templates:

```bash
cp deploy/.env.stackit.example                 deploy/.env.stackit
cp deploy/terraform/terraform.tfvars.example   deploy/terraform/terraform.tfvars
```

Fill `deploy/.env.stackit` (SA key path, `STACKIT_DNS_NAME=<your-domain>`) and the tfvars in
Step 2.

---

## Step 1 — STACKIT Network Area (SNA) in the portal *(this bites everyone)*

Before any Terraform, set up the **STACKIT Network Area (SNA)** in the portal. SKE clusters
attach to an SNA, and if the area is not **Active with the EU01 region enabled** the cluster
will provision but pods will have broken networking. Do this first and confirm it is healthy.

In the STACKIT portal → your organization → **Network Areas**, create (or verify) one area:

| Setting | Value |
|---|---|
| **State** | **Active** — and the **region (`eu01`) explicitly enabled** on the area |
| **Network range** (the SNA's address space) | `10.0.0.0/16` |
| **Transfer range** | `192.168.0.0/24` |
| **DNS nameservers** | `8.8.8.8`, `8.8.4.4` (or your own resolvers) |
| **Default prefix length** | `24` |
| **Min prefix length** | `22` |
| **Max prefix length** | `29` |

> **Do not skip the "region enabled" toggle.** An SNA can show *Active* at the org level but
> still not have EU01 turned on — SKE then comes up in a half-broken state. Confirm both the
> area is Active **and** EU01 is enabled before you run Terraform.

---

## Step 2 — Terraform: single-zone, one node

The repo's Terraform **defaults are now this single-node layout** — a plain `tofu apply` gives
you one `g2i.8` node in a single AZ (`eu01-1`), node pool `min=1/max=1`, Kubernetes `1.34`. You
still create `deploy/terraform/terraform.tfvars` for the required inputs (`project_id`,
`dns_name`, SA key). The node-pool block below is shown explicitly so the config is self-evident
and pinned in your tree; it matches the defaults (copy `terraform.tfvars.example`):

```hcl
# deploy/terraform/terraform.tfvars  (gitignored)

project_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"   # your STACKIT project ID
dns_name   = "agentic-os.example.com"                 # the domain you control

service_account_key_path = "../../../stackit/sa-key.json"

region      = "eu01"
name_prefix = "dm-agos"          # ⚠ SKE cluster name MUST be ≤ 11 chars (see Cautions)

# --- self-hosted: SKE + DNS only, all backends bundled in-cluster ---
enable_managed_backends = false

# --- single node, single zone ---
kubernetes_version_min = "1.34"  # ⚠ 1.31 (the old default) is REJECTED — see Cautions
node_machine_type      = "g2i.8" # 8 vCPU / 32 GB  (⚠ c1.4 is deprecated — see Cautions)
node_pool_min          = 1
node_pool_max          = 1        # ⚠ with one AZ, max=1 is fine (see the multi-AZ caution)
availability_zones     = ["eu01-1"]
node_volume_size_gb    = 50
```

> Single-AZ + `min=1/max=1` is deliberate: a one-node pool cannot be multi-AZ (SKE requires
> `node_pool_max ≥ number of AZs`). Keep both at **1** and the AZ list to a **single** zone.

Apply it. Either drive it through the repo's automation (which threads the self-hosted mode
and the cost gate for you):

```bash
# Recommended: one command — provision SKE+DNS, write kubeconfig, render, GitOps deploy.
./deploy/stackit deploy --self-hosted
```

…or run the Terraform step directly while you verify networking before deploying the app:

```bash
make -C deploy validate                              # safe: no STACKIT calls
make -C deploy apply  MODE=selfhosted CONFIRM=I-ACCEPT-MODE-A-COSTS   # ⚠ first real spend
make -C deploy kubeconfig                            # writes deploy/kubeconfig.yaml (mode 600)
export KUBECONFIG="$PWD/deploy/kubeconfig.yaml"
kubectl get nodes                                    # expect ONE node, Ready
```

> `tofu`/`terraform` is auto-detected. If you prefer raw OpenTofu:
> `tofu -chdir=deploy/terraform apply -var enable_managed_backends=false`.

---

## Step 3 — ⚠ VERIFY pod networking BEFORE deploying

**Do this before anything else lands on the cluster.** A throwaway pod must resolve DNS and
reach the API server. If this fails, the SNA/CNI plumbing is wrong and deploying the stack
will only produce a pile of CrashLoopBackOff — stop and fix it first.

```bash
kubectl run net --image=busybox:1.36 --rm -it --restart=Never -- \
  nslookup kubernetes.default
```

**Expected:** it resolves `kubernetes.default.svc.cluster.local` to the service ClusterIP and
exits cleanly. **On the single-node layout this just works** — the pod, CoreDNS, and every
service share the one node, so there is no cross-node hop to fail. (It is exactly the cross-node
hop that is broken on multi-node SKE-in-an-SNA; see [Cautions](#tips--cautions-stackit-specific).)
Run the check anyway — it is a 5-second confirmation that the SNA/CNI plumbing is healthy.

If it **hangs or fails** (no resolution, timeouts) — unusual on a single node, but possible if
the SNA itself is misconfigured:

1. Re-check the **SNA** is *Active* **with EU01 enabled** (Step 1) and the DNS nameservers are set.
2. Confirm the node is `Ready` and Cilium pods in `kube-system` are healthy.
3. If it still fails, **stop and open a STACKIT support ticket** — see the
   [SNA pod-networking caveat](#tips--cautions-stackit-specific). Do not proceed to deploy.

Only continue once `nslookup kubernetes.default` succeeds.

---

## Step 4 — Build + push **amd64** images

SKE nodes are **x86-64**. Images built on Apple Silicon default to `arm64`, which crash on SKE
with `exec format error`. **Always build for `linux/amd64`** and push to a registry SKE can
pull from (STACKIT Container Registry, GHCR, etc.).

```bash
# One-time: a buildx builder that can cross-build.
docker buildx create --use --name agos 2>/dev/null || docker buildx use agos

REG=registry.eu01.onstackit.cloud/<your-namespace>     # your registry path

docker buildx build --platform linux/amd64 \
  -t "$REG/mock-model:0.1.0"  images/mock-model  --push
docker buildx build --platform linux/amd64 \
  -t "$REG/sample-agent:0.1.0" images/sample-agent --push
# …repeat for the other bespoke images under images/ (os-ui, admin-console, web-fetch, …).
```

> The repo also ships `deploy/scripts/publish-images.sh` (digest-pinned, dry-run by default;
> add `--push`) — `make -C deploy images ARGS=--push`.

**Attach the pull secret** so the namespace's ServiceAccounts can pull the private images:

```bash
kubectl create namespace agentic-os 2>/dev/null || true

kubectl -n agentic-os create secret docker-registry registry-pull-secret \
  --docker-server="$REG" --docker-username='<user>' --docker-password='<token>'

# Attach to the default SA (and any others the chart runs as) so every pod inherits it:
kubectl -n agentic-os patch serviceaccount default \
  -p '{"imagePullSecrets":[{"name":"registry-pull-secret"}]}'
```

---

## Step 5 — Deploy the self-contained chart

Deploy the umbrella chart with the **self-contained** values so every backend is bundled
in-cluster, plus an ingress overlay for public hostnames on `*.<domain>`.

```bash
helm dependency build charts/sovereign-agentic-os

helm upgrade --install agentic-os charts/sovereign-agentic-os \
  -n agentic-os --create-namespace \
  -f values.selfcontained.yaml \
  -f values.stackit-selfhosted.yaml \
  --set global.profile=local \
  --set 'global.imagePullSecrets[0].name=registry-pull-secret'
```

Key points:

- **`profile: local` (NOT `stackit`)** is correct for the self-contained stack — it lets the
  chart create the bundled dev backends/secrets it needs. (`values.stackit-selfhosted.yaml`
  defaults `profile: stackit`; the `--set global.profile=local` above overrides it for the
  self-contained single-node demo.)
- `values.stackit-selfhosted.yaml` turns ingress **on** and re-enables the heavier Layer-2
  components (Docling, OpenSearch Dashboards, OpenMetadata) that the local kind profile turns
  off — a 32 GB node has room for the full L1–L3 set.
- Hostnames are `os.<domain>`, `litellm.<domain>`, `langfuse.<domain>`, `superset.<domain>`,
  `forgejo.<domain>`, `argocd.<domain>`, `openmetadata.<domain>` — all behind the wildcard.
- Put the platform behind a **basic-auth gate** at the ingress so the consoles are not open to
  the world before you've set real logins:

  ```bash
  htpasswd -cb auth admin 'a-strong-password' && \
  kubectl -n agentic-os create secret generic os-basic-auth --from-file=auth && rm auth
  # then annotate the ingress(es): nginx.ingress.kubernetes.io/auth-type: basic,
  # auth-secret: os-basic-auth, auth-realm: "Sovereign Agentic OS".
  ```

Watch it come up:

```bash
kubectl -n agentic-os get pods -w
```

> **If the Argo/redis bootstrap hook stalls:** Langfuse's bundled redis/valkey provisioning can
> hang on a Helm/Argo hook. Install with **`--no-hooks`** and **create the secret yourself**
> instead of waiting on the hook job, then let the workloads reconcile.

---

## Step 6 — DNS + TLS

Point your domain at the ingress load balancer, then let cert-manager issue TLS automatically.

```bash
# Get the ingress LB public IP (wait until it's assigned):
kubectl -n ingress-nginx get svc ingress-nginx-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}{"\n"}'
```

Create two A-records at your DNS provider (or in the STACKIT DNS zone Terraform created):

| Record | Type | Value |
|---|---|---|
| `agentic-os.example.com` (apex) | `A` | `<ingress LB IP>` |
| `*.agentic-os.example.com` (wildcard) | `A` | `<ingress LB IP>` |

If you used the repo automation, `make -C deploy dns` reads the LB IP and patches the STACKIT
DNS records for you. **TLS is automatic** via Let's Encrypt (`tlsIssuer: letsencrypt-prod` in
the overlay); cert-manager issues certs once DNS resolves. Confirm:

```bash
curl -I https://os.agentic-os.example.com
```

---

## Step 7 — Operate (and the off-hours cost window)

Because everything is in-cluster, scaling the node pool to **0** pauses the **whole** stack —
only the load balancer + DNS keep a small charge. Drive it from your Mac:

```bash
./deploy/stackit status                 # node pool + pod summary
./deploy/stackit off                    # sleep: SKE node pool → 0 (overnight)
./deploy/stackit on                     # wake: node pool back to 1
./deploy/stackit schedule 08:00 20:00   # auto on/off daily (launchd)
./deploy/stackit urls                   # the public console hostnames
./deploy/stackit open                   # open the OS UI in a browser
```

Further cost control:

- **Turn off optional Layer-2/4 components** you don't need (set `<component>.enabled: false`):
  the heavier Docling / OpenSearch Dashboards / OpenMetadata, and Layer-4 Science/ML (off by
  default) all free RAM and let you run on a smaller node if you want.
- `./deploy/stackit off` is the big lever — a single-node pool at 0 means no compute spend.
- `launchd` only fires while your Mac is awake; for an always-on schedule use the in-cluster
  KEDA cron (see `deploy/README.md`).

---

## Tips & Cautions (STACKIT-specific)

> Read this before you provision. Every item here is a real thing that has bitten this stack.

- **Kubernetes `1.31` is rejected.** The old tfvars default no longer provisions — set
  `kubernetes_version_min = "1.34"`.
- **SKE cluster name ≤ 11 characters.** `name_prefix` becomes the cluster name; the default
  `dm-agentic-os` (13 chars) is too long. Use something like `dm-agos`.
- **`c1.4` is deprecated** — use **`g2i.8`** (8 vCPU / 32 GB). Confirm the exact flavor name in
  the STACKIT machine-type catalog for your project before `apply`.
- **SKE kubeconfig defaults to ~1 h expiry.** For day-2 work set a longer TTL (e.g. **30 days**)
  when you create the kubeconfig, or you'll be re-issuing it constantly.
- **Multi-AZ requires `node_pool_max ≥ number of AZs`.** For one node, use a **single AZ**
  (`["eu01-1"]`) with `min=1/max=1`. Don't list 3 AZs for a 1-node pool.
- **Use `profile: local`, not `profile: stackit`,** for the self-contained (bundled) stack —
  `local` provisions the bundled dev backends/secrets the chart needs.
- **ARM images crash on SKE** with `exec format error` — SKE nodes are x86-64. Always
  `docker buildx build --platform linux/amd64`.
- **The Argo/redis bootstrap hook can stall.** Install with **`--no-hooks`** and create the
  secret yourself, then let the workloads reconcile, rather than waiting on the hook job.
- **⚠ Root cause — cross-node pod networking is BROKEN on SKE-in-an-SNA.** This is the single
  most important STACKIT finding, and it is why single node is the only verified path. On an SKE
  cluster attached to a STACKIT Network Area (SNA), **a pod scheduled on a node *without* a
  CoreDNS replica cannot reach DNS or any pod on another node** — verified: same-node traffic
  works, cross-node is **100% loss** ("no servers could be reached"). On the first multi-node
  deploy this is what took down the Postgres-backed components: **CloudNativePG's init pod landed
  on the "bad" node, could not resolve its service, and the whole stateful bootstrap cascaded.**
  - **A single node sidesteps it entirely** — with one node there is no cross-node traffic, so
    DNS/overlay always works. That is the fix; do not add nodes until STACKIT confirms cross-node
    overlay for SKE-in-an-SNA.
  - *Earlier framing, now corrected:* this was first mis-diagnosed as an **"SNA DNS"** problem —
    the SNA's external resolvers (`8.8.8.8`) "couldn't resolve the internal SKE API hostname".
    That was a **downstream symptom observed on the multi-node cluster**, not the root cause. The
    real defect is the **cross-node overlay dataplane**; the resolver/hostname noise disappears on
    a single node.
  - Still run the [Step 3 check](#step-3--verify-pod-networking-before-deploying) before deploying.
    If it ever fails on a single node, the SNA itself is misconfigured (Step 1) — **open a STACKIT
    support ticket** rather than fighting the chart.

---

## Known-blocked paths (do not start here)

Both of these put workloads on **more than one node**, and **cross-node pod networking on
SKE-in-an-SNA is broken** (see [Cautions](#tips--cautions-stackit-specific)). They are wired in
the repo but are **not deployable on STACKIT today** — revisit only once STACKIT confirms
cross-node pod-to-pod overlay (and you have a support resolution in hand).

- **Multi-node HA** — directly blocked: more than one node means the broken cross-node overlay
  bites (CloudNativePG and anything stateful cascade as soon as an init pod lands on the "wrong"
  node).
- **Managed services (Mode B)** — points Postgres/OpenSearch/object storage/LLM at STACKIT
  managed services (and bills 24/7). Wired in `deploy/` + `values.stackit-managed.yaml`, but it
  is sized for a multi-node pool and so inherits the same cross-node networking block; the
  chart-side external wiring is also still a follow-up. See `deploy/README.md`.

## See also

- `deploy/README.md` — the deploy automation (Terraform + Argo CD), modes, and cost model.
- `docs/cloud-configuration.md` — what you configure in your cloud account.
- `docs/getting-started.md` — local (kind) quickstart.
- `docs/Sovereign-Agentic-OS-Guide.md` — the full end-user guide.
