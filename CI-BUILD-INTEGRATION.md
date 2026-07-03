# CI build job — integration notes (for the chart owner)

This worktree turns the placeholder CI workflow (`echo BUILD_OK`) into a **real build job**:
push → Forgejo Actions builds a container image → pushes it to Forgejo's built-in OCI registry
→ Argo CD redeploys the built image. Everything is wired in the chart; this file lists the few
things **you** must apply outside my allowed file set, plus deploy/verify steps.

See `docs/components/ci-build.md` for the design and `docs/components/ci-runner.md` context.

## What I changed (in this worktree)

- **NEW** `images/ci-builder/Dockerfile` → `sovereign-os/ci-builder:0.1.0` (node:20-bookworm +
  Docker CLI 27.5.1 + buildx 0.20.1 + git + curl, all pinned by digest).
- **EDIT** `charts/sovereign-agentic-os/templates/software/ci-runner.yaml`
  - runner label → `docker:docker://forgejo-http:3000/<admin>/ci-builder:<builderTag>`
  - `ci-runner-config` ConfigMap (act_runner config; **`container.network: host`** — the
    job→DinD fix) mounted at `/config`, daemon started with `--config`
  - `ci-runner-dind` Service (exposes DinD :2375 in-namespace for the publish hook)
  - `ci-builder-dockerfile` ConfigMap + `ci-builder-publish` post-install Job (builds ci-builder
    in DinD and pushes it to Forgejo so act_runner can pull the job image)
  - runner re-registers if the persisted label changed (upgrade safety)
- **EDIT** `charts/sovereign-agentic-os/templates/software/forgejo-seed.yaml`
  - seeds real source (`index.html`, `Dockerfile`), `manifests/app.yaml` (references the built
    image `forgejo-http:3000/<admin>/demo-app:<tag>`), the real `.forgejo/workflows/ci.yml`,
    and a `REGISTRY_PASS` Forgejo Actions secret
- **NEW** `docs/components/ci-build.md`

I did **not** touch `values.yaml`, `Chart.yaml`, `install.sh`, `scripts/build-images.sh`,
`argocd-app.yaml`, `os-ui/`, or the repo-root `README.md`. Apply the items below.

---

## 1) values.yaml additions (optional but recommended)

The templates already work with defaults (`builderTag` falls back to `0.1.0`). To make it
explicit / configurable, under `ciRunner:` add:

```yaml
ciRunner:
  enabled: true
  image: code.forgejo.org/forgejo/runner:6
  dindImage: docker:27-dind        # consider pinning by digest (supply-chain baseline)
  builderTag: "0.1.0"              # tag for the ci-builder job image (NEW)
```

Notes:
- `softwareDelivery.demoApp.image` (currently `traefik/whoami:v1.10.3`) is **no longer
  referenced** — the manifest now points at the CI-built image. You can delete that line.
- Pin `dindImage` to a digest to match the security baseline (the CLI/buildx in ci-builder are
  already digest-pinned to 27.5.1).

## 2) scripts/build-images.sh line (optional — host/local builds only)

ci-builder for the **in-cluster** job is delivered by the `ci-builder-publish` hook (into
Forgejo's registry), **not** by `kind load` — `kind load` populates the node's containerd, which
is a different daemon from DinD. Adding the line only gives you a local copy for host validation:

```sh
# add to the IMAGES list in scripts/build-images.sh
ci-builder:0.1.0
```

(Build context is `images/ci-builder`, matching the default `build_one` behavior.)

## 3) kind containerd insecure-registry config (REQUIRED for the deployed pod to pull)

**The kind pull gotcha.** The runner/DinD already trust `forgejo-http:3000` (plain HTTP). But
the **deployed demo-app pod** is pulled by the kind node's **containerd**, which by default (a)
can't resolve the in-cluster name `forgejo-http` and (b) tries HTTPS. Fix both:

### 3a) Reproducible: bake it into the kind cluster config (at create time)

```yaml
# kind-config.yaml  (used by: kind create cluster --name agentic-os --config kind-config.yaml)
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
containerdConfigPatches:
  - |-
    [plugins."io.containerd.grpc.v1.cri".registry]
      config_path = "/etc/containerd/certs.d"
    [plugins."io.containerd.grpc.v1.cri".registry.configs."forgejo-http:3000".tls]
      insecure_skip_verify = true
nodes:
  - role: control-plane
```

Then drop a hosts.toml so containerd uses plain HTTP for that registry:

```bash
NODE=agentic-os-control-plane   # kind node container name
docker exec "$NODE" mkdir -p /etc/containerd/certs.d/forgejo-http:3000
docker exec "$NODE" sh -c 'cat > /etc/containerd/certs.d/forgejo-http:3000/hosts.toml <<EOF
server = "http://forgejo-http:3000"
[host."http://forgejo-http:3000"]
  capabilities = ["pull", "resolve"]
  skip_verify = true
EOF'
```

### 3b) Make `forgejo-http` resolvable on the node

containerd uses the node's resolver, not cluster DNS — but kube-proxy makes ClusterIPs
reachable from the node, so we just need the name. Point it at the Service ClusterIP:

```bash
NODE=agentic-os-control-plane
CIP=$(kubectl -n agentic-os get svc forgejo-http -o jsonpath='{.spec.clusterIP}')
docker exec "$NODE" sh -c "grep -q forgejo-http /etc/hosts || echo '$CIP forgejo-http' >> /etc/hosts"
```

(ClusterIP is stable for the life of the install. Re-run after a reinstall. No containerd
restart needed for the hosts.toml; if you patched config via `docker exec` instead of the kind
config, `docker exec $NODE systemctl restart containerd`.)

### 3c) Anonymous pull / pull secret

The deployed pod has no registry creds. Forgejo serves **anonymous pulls for public packages**,
and `gitea_admin`'s packages are public by default — so the plain manifest works. If your
Forgejo restricts anonymous package access, create a pull secret in the `demo` namespace and add
it to the manifest:

```bash
kubectl -n demo create secret docker-registry forgejo-reg \
  --docker-server=forgejo-http:3000 \
  --docker-username=gitea_admin --docker-password=forgejo-admin-local-dev
# then add to manifests/app.yaml podSpec:  imagePullSecrets: [ { name: forgejo-reg } ]
```

(The `demo` namespace is created by Argo with `CreateNamespace=true`; create the secret after
first sync, or template it into the chart in the `demo` namespace.)

---

## 4) Deploy & verify (kind, local)

```bash
# 0) build ci-builder locally (optional; the in-cluster publish hook also builds it)
docker build -t sovereign-os/ci-builder:0.1.0 images/ci-builder

# 1) install/upgrade the chart (your normal flow), then watch the wiring:
kubectl -n agentic-os logs job/ci-builder-publish            # builds+pushes ci-builder -> Forgejo
kubectl -n agentic-os logs job/forgejo-seed                  # seeds source + workflow + secret
kubectl -n agentic-os logs deploy/ci-runner -c runner -f     # picks up the workflow run

# 2) confirm the image landed in Forgejo's registry (port-forward forgejo first)
kubectl -n agentic-os port-forward svc/forgejo-http 3001:3000 &
curl -u gitea_admin:forgejo-admin-local-dev http://localhost:3001/v2/_catalog
curl -u gitea_admin:forgejo-admin-local-dev http://localhost:3001/v2/gitea_admin/demo-app/tags/list

# 3) confirm Argo redeployed the built image
kubectl -n demo get deploy demo-app -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
kubectl -n demo get pods -l app=demo-app
kubectl -n demo port-forward deploy/demo-app 8088:8080 &
curl -s localhost:8088 | grep -o 'Deployed by Sovereign Agentic OS CI'
```

Expected: `_catalog` lists `gitea_admin/ci-builder` and `gitea_admin/demo-app`; `tags/list`
shows a 12-char commit SHA; the demo-app Deployment image ends in that SHA; the page says
"Deployed by Sovereign Agentic OS CI".

---

## 5) Ordering / hook weights

`helm` waits for each hook weight to complete before the next, so the chain is safe:
- `21` ci-runner RBAC → `22` ci-runner-token (runner registration token)
- `24` **ci-builder-publish** (ci-builder image present in Forgejo before any workflow fires)
- `25` **forgejo-seed** (seeds source + secret, then the workflow file last → triggers the run)
- `35` argocd-app (the Argo Application)

The `ci-runner` Deployment + `ci-runner-dind` Service are main-phase resources (applied before
post-install hooks), so DinD is up when the publish hook runs.

---

## 6) Gaps / things to watch

- **In-cluster end-to-end is unproven by me** (no live-cluster mutation allowed). I proved the
  builder image + DOCKER_HOST→DinD + build + authenticated push end-to-end with **local Docker**
  (see the report / `docs/components/ci-build.md`). The act_runner `container.network: host`
  path is reasoned, not cluster-tested — verify with step 4 above.
- **Upgrade & the runner PVC:** the `.runner` registration persists on the PVC. I added a guard
  that re-registers when the persisted label lacks `ci-builder`, but if you change `builderTag`
  only, the label still contains `ci-builder` and won't re-register. Either keep the label
  stable or `kubectl -n agentic-os delete pvc ci-runner-data` (then the runner re-registers).
- **DinD Service is an unauthenticated daemon** reachable in-namespace — fine for local (intra-
  namespace, default-deny between namespaces), remove/replace with rootless kaniko on STACKIT.
- **Two copies of the ci-builder Dockerfile** (`images/ci-builder/Dockerfile` for host/build-
  images.sh and the `ci-builder-dockerfile` ConfigMap in `ci-runner.yaml` for the in-cluster
  publish hook). Keep the `FROM` digests in sync if you bump them.
- **Intra-namespace NetworkPolicy:** if you tighten egress within `agentic-os`, ensure the
  publish Job → `ci-runner-dind:2375` and the runner/DinD → `forgejo-http:3000` paths are
  allowed.
