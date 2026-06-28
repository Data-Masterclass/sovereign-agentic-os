# CI build job — push → build → push image → redeploy

**What it is:** the *real* Software golden path. A push to `demo-app` triggers a Forgejo
Actions workflow that **builds a container image, pushes it to Forgejo's built-in OCI
registry, and bumps the deployment manifest** so Argo CD redeploys the freshly built image.
This replaces the old placeholder workflow (`echo BUILD_OK`).

```
git push ─▶ Forgejo Actions ─▶ act_runner (job in ci-builder container)
            │
            ├─ docker build  ─┐
            ├─ docker push    ├─▶ in-pod Docker-in-Docker (DinD) ─▶ forgejo-http:3000 (OCI registry)
            └─ bump manifest ─┘        │
                  │                    └─ image: forgejo-http:3000/gitea_admin/demo-app:<sha>
                  ▼
            commit "[skip ci]" ─▶ Argo CD auto-sync ─▶ demo namespace (new image rolls out)
```

## The pieces

| Piece | Where | Role |
|---|---|---|
| **ci-builder image** | `images/ci-builder/Dockerfile` → `sovereign-os/ci-builder:0.1.0` | The job-container toolbox: `node:20-bookworm` + Docker CLI + buildx + git + curl (CLI/buildx version-matched to the DinD daemon, copied from `docker:27.5.1-cli`). |
| **DinD sidecar** | `ci-runner` Deployment | Privileged Docker daemon; the build engine. Trusts `forgejo-http:3000` as an insecure (plain-HTTP) registry. |
| **act_runner** | `ci-runner` Deployment | Picks up workflows, runs each `runs-on: docker` job *inside* the ci-builder container on the DinD daemon. |
| **ci-builder-publish** | post-install Job | Builds ci-builder in DinD and pushes it to Forgejo's registry so act_runner can pull it as the job image. |
| **demo-app source** | seeded `gitea_admin/demo-app` | Real buildable source: `index.html` + `Dockerfile` (nginx-unprivileged static site), `manifests/app.yaml`, `.forgejo/workflows/ci.yml`. |

## The crux: how a job container reaches the DinD daemon

A `runs-on: docker` job does **not** run in the runner sidecar — act_runner starts a *new*
container (the ci-builder image) on the DinD daemon and runs the steps there. Inside that job
container, `localhost` is the job's own network namespace, **not** the DinD daemon — so a
naive `DOCKER_HOST=tcp://localhost:2375` would point at nothing.

**Solution — `container.network: host` in the act_runner config** (mounted ConfigMap
`ci-runner-config`). With host networking, the job container shares the **pod** network
namespace — the exact namespace the in-pod DinD daemon binds `0.0.0.0:2375` on. So inside the
job container, `DOCKER_HOST=tcp://localhost:2375` reaches the DinD daemon, identically to how
the runner sidecar already does. No Service, no `host-gateway` tricks, no IP guessing.

The workflow sets `DOCKER_HOST: tcp://localhost:2375` explicitly in its job `env:` so the
`docker` CLI in each step targets the DinD daemon.

> Alternative (documented, not used): keep the job on a bridge network and reach the daemon via
> `--add-host=host.docker.internal:host-gateway` + `DOCKER_HOST=tcp://host.docker.internal:2375`
> (`container.options` in the act config). Host networking is simpler and mirrors the sidecar.

## Why publish ci-builder to the registry

DinD storage is an `emptyDir`; `kind load` populates the *node's* containerd, **not** DinD's
docker. So the job image must come from somewhere DinD can pull. The `ci-builder-publish`
post-install Job builds ci-builder in DinD (via the `ci-runner-dind` Service) and pushes it to
Forgejo's registry; the runner label is
`docker:docker://forgejo-http:3000/gitea_admin/ci-builder:0.1.0`, so DinD pulls it from there
(and re-pulls after a restart, since the registry is on Forgejo's PVC).

## The workflow (`.forgejo/workflows/ci.yml`)

Fully sovereign — **no external actions** (nothing from github.com, which egress policy blocks):

1. **Checkout** — manual `git clone` over `http://forgejo-http:3000` (creds from the
   `REGISTRY_PASS` Actions secret, seeded by the install).
2. **Build & push** — `docker login forgejo-http:3000`, `docker build`, `docker push
   forgejo-http:3000/gitea_admin/demo-app:<12-char-sha>`.
3. **Bump manifest** — `sed` the new tag into `manifests/app.yaml`, commit `"ci: deploy <tag>
   [skip ci]"`, push. The `[skip ci]` marker stops the bump from re-triggering CI. Argo CD
   sees the new tag and redeploys.

## Inspect

```bash
# runner / DinD
kubectl -n agentic-os logs deploy/ci-runner -c runner --tail=30
kubectl -n agentic-os logs deploy/ci-runner -c dind   --tail=30
# the publish hook
kubectl -n agentic-os logs job/ci-builder-publish
# workflow runs (port-forward forgejo first: svc/forgejo-http 3001:3000)
curl -u gitea_admin:forgejo-admin-local-dev \
  http://localhost:3001/api/v1/repos/gitea_admin/demo-app/actions/tasks
# images in Forgejo's registry
curl -u gitea_admin:forgejo-admin-local-dev http://localhost:3001/v2/_catalog
curl -u gitea_admin:forgejo-admin-local-dev \
  http://localhost:3001/v2/gitea_admin/demo-app/tags/list
# the deployed result
kubectl -n demo get deploy,pods -l app=demo-app
```

## FAQ

**Q: Won't the manifest-bump commit loop forever?** No — it's committed with `[skip ci]`,
which Forgejo Actions honors (also `[ci skip]`, `[no ci]`, `[skip actions]`).

**Q: Production?** Swap privileged DinD for rootless **kaniko/buildah**, push to **Harbor**
(scan with Trivy + sign with cosign), and use an image-updater (Argo CD Image Updater) instead
of committing tags. The `forgejo-http:3000` insecure-registry trust is local-only.

**Q: First install shows `ImagePullBackOff` on demo-app?** Expected for a few seconds: the
seeded manifest references `:bootstrap` (doesn't exist) until the first CI run builds and bumps
the tag. Once CI completes, Argo redeploys the real `:<sha>` image.
