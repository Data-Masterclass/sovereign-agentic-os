# Installing the OS on your own machine or server (`./scripts/os up`)

`./scripts/os up` creates a kind cluster, builds the OS images from this checkout, loads them into the cluster,
resolves the chart's dependencies and installs the chart with `values.local.yaml`. This page covers what it
needs from the machine and the network, how to run it behind a proxy or firewall, and what to do when it fails.

## Prerequisites

| Tool | Notes |
| --- | --- |
| Docker | Docker Engine, Docker Desktop or Colima. About 10 GB of memory for the build (the Langfuse web build is a full Next.js build) and about 30 GB of disk. |
| kind, kubectl, helm | Helm 3.8+ or Helm 4. |
| curl | Used for the health check. |
| python3 with PyYAML | Reads the values files (`apt install python3-yaml` or `pip install pyyaml`). |

A first run takes 15 to 40 minutes, mostly image builds. Later runs reuse the Docker build cache.

## Network destinations

Without a proxy or firewall you can skip this section. With an egress allowlist, these are the hosts the
install reaches. The list comes from the Dockerfiles that `scripts/os` builds and from `Chart.yaml`:
`python3 scripts/lib/local-images.py hosts` prints it, along with the images that need each host.
`scripts/tests/local-images.test.sh` fails CI when a host it finds is missing from this table.

All of them are HTTPS (443) unless the table says otherwise.

### Image builds (`docker build` on the host)

| Host | Needed by | Why |
| --- | --- | --- |
| `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com` | every image | Base images (`node`, `python`, `alpine`, `golang`) from Docker Hub. The last two hosts are Docker Hub's token service and blob CDN. |
| `quay.io`, `cdn01.quay.io`, `cdn02.quay.io`, `cdn03.quay.io` | docling | Base image `quay.io/docling-project/docling-serve-cpu`. The CDN hosts serve the image layers. |
| `dl-cdn.alpinelinux.org` | egress-proxy, git-daemon, git-http, langfuse | `apk add` (Alpine packages). |
| `deb.debian.org` on **port 80 and 443**, `security.debian.org` on **port 80** | dagster, litellm | `apt-get` (Debian packages). The Debian base images use plain HTTP; packages are verified by apt's signatures. Current images get security updates from `deb.debian.org/debian-security`, older ones from `security.debian.org`. Allow both. |
| `pypi.org`, `files.pythonhosted.org` | dagster, dbt, data-runner, query-tool, litellm | `pip install` (Python packages). |
| `registry.npmjs.org` | os-ui, litellm, langfuse | `npm ci` / `pnpm install` (Node packages). |
| `nodejs.org` | litellm | The Node.js runtime for Prisma (checksum-verified download). |
| `binaries.prisma.sh` | litellm, langfuse | Prisma engine binaries (`prisma generate`, `prisma py fetch`, the Prisma CLI's install step). |
| `github.com`, `codeload.github.com` | langfuse | `git fetch` of the pinned Langfuse commit. |
| `proxy.golang.org`, `sum.golang.org` | langfuse | `go install` of `golang-migrate` (module proxy and checksum database). |
| `huggingface.co`, `*.hf.co` | docling | The pinned TableFormer and MiniLM model files. Hugging Face serves them from its LFS and Xet CDNs: `cdn-lfs.hf.co`, `cdn-lfs-us-1.hf.co`, `cdn-lfs-eu-1.hf.co`, `cas-bridge.xethub.hf.co`, `cas-server.xethub.hf.co`, `transfer.xethub.hf.co`. If your firewall cannot allow a wildcard, allow those six. |

### Chart dependencies (`helm` on the host)

| Host | Why |
| --- | --- |
| `langfuse.github.io`, `opensearch-project.github.io`, `dagster-io.github.io` | The chart repositories in `Chart.yaml` (their `index.yaml`, and the Dagster chart archive). |
| `github.com`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com` | The Langfuse and OpenSearch chart archives are GitHub release assets, so `github.com` redirects to the asset hosts. |
| `ghcr.io`, `pkg-containers.githubusercontent.com` | The LiteLLM chart is an OCI artifact (`oci://ghcr.io/berriai`). It is a public package, so no login is needed. |

### Images the cluster pulls (containerd in the kind node)

Everything the OS builds itself is loaded into the node, so the node never pulls it. The node pulls only public
upstream images:

| Host | Images |
| --- | --- |
| `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com` | `kindest/node` (when the cluster is created), Postgres, ClickHouse, Valkey, OpenSearch, Trino, Polaris, OPA, the OpenTelemetry Collector, VictoriaMetrics/VictoriaLogs, busybox, curl, aws-cli, node |
| `cgr.dev` | MinIO (Chainguard's public build, pinned by digest) |

### At runtime

On a laptop install the OS makes no outbound calls unless you set `STACKIT_API_KEY` or add a model provider.
Model and connection traffic leaves only through the chart's egress proxy, which has its own allowlist in git
(`egressProxy` in the chart values).

## Behind a proxy

Export the proxy variables in the shell that runs `./scripts/os up`:

```bash
export HTTP_PROXY=http://proxy.example.com:3128 HTTPS_PROXY=http://proxy.example.com:3128
export NO_PROXY=localhost,127.0.0.1,.svc,.cluster.local,10.96.0.0/12,10.244.0.0/16
./scripts/os up
```

What reads the variables:

- **docker build.** `scripts/os` passes every one of `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` and
  `FTP_PROXY` that is set (upper and lower case) to each build as `--build-arg NAME`. These are Docker's predefined
  proxy build args, so they are not written into the image history. A proxy on the host's loopback
  (`127.0.0.1:3128`) cannot be reached from a build container. Use an address the containers can reach, or set
  `OS_BUILD_NETWORK=host` so the builds use the host network.
- **kind.** `kind create cluster` copies the proxy variables into the node container, which is how containerd
  pulls through the proxy, and adds the cluster's own ranges to `NO_PROXY`. This happens only when the cluster is
  created. A cluster created before you set the variables keeps the old environment, so recreate it with
  `./scripts/os down`.
- **helm.** Helm uses the variables directly.
- **Docker daemon pulls of base images.** Configure the Docker daemon's own proxy (`/etc/systemd/system/docker.service.d/http-proxy.conf`
  on Linux, or the Docker Desktop settings). The shell variables do not reach the daemon.

## Images: what is built locally and what is private

`scripts/os` builds every OS image the local profile runs and loads it into kind. The list is
`scripts/lib/local-images.py` (`python3 scripts/lib/local-images.py plan` prints it): os-ui, egress-proxy,
web-fetch, mock-model, git-daemon, git-http, dagster (webserver, daemon, code location, repo-sync sidecar and run
pods), dbt, data-runner, query-tool, docling, litellm, langfuse web and langfuse worker.

The chart pins these images by registry digest in private ghcr.io packages. A local build cannot carry a registry
digest, so `values.local.yaml` points each of them at a local tag (`sovereign-os/<name>:local`, or the chart tag
with `localBuild: true`). The Dagster code location sits in a list, and Helm replaces lists instead of merging
them, so its full entry is copied into `values.local.yaml` by `python3 scripts/lib/local-images.py gen-values --write`.
CI fails when that copy drifts from `values.yaml`, and also when the local render names an image that is neither
built by the script nor public (`scripts/tests/local-images.test.sh`).

For a **pull-only** install (no local builds, for example on a cluster without Docker on the operator's machine),
these packages would need to be public, or the cluster would need a pull secret for them. Whether to make them
public is the owner's decision; they are private today:

| Package | Used for |
| --- | --- |
| `ghcr.io/data-masterclass/sovereign-os/dagster` | Dagster webserver, daemon, code location, repo-sync, run pods |
| `ghcr.io/data-masterclass/sovereign-os/litellm-oss` | model gateway |
| `ghcr.io/data-masterclass/sovereign-os/langfuse-oss-web`, `…/langfuse-oss-worker` | observability |
| `ghcr.io/data-masterclass/sovereign-os/docling` | document parsing |
| `ghcr.io/data-masterclass/sovereign-os/minio` | object storage (the local profile uses Chainguard's public build of the same digest instead) |
| `ghcr.io/data-masterclass/sovereign-os` (os-ui) | the OS itself (the deploy pipelines' image) |
| `ghcr.io/aborek/sovereign-os/git-daemon`, `…/git-http` | the git sidecars of os-ui |
| `ghcr.io/aborek/sovereign-os/data-runner` | data-runner |

## When it fails

`scripts/os up` never waits without a limit:

- **A build fails.** The script prints the last 80 lines of that image's build log and the path of the full log.
  Behind a firewall, the error names the host it could not reach; compare it with the tables above. To rebuild
  one image with live output, run `OS_VERBOSE=1 LOCAL_IMAGES_ONLY=<key> ./scripts/os up`. The keys are listed by
  `python3 scripts/lib/local-images.py plan`.
- **Chart dependencies.** `scripts/lib/helm-deps.sh` adds the repositories from `Chart.yaml` (safe to repeat),
  then builds exactly the versions in `Chart.lock`, with three attempts.
- **The install or the rollout fails.** After the Helm install, the os-ui rollout (`OS_ROLLOUT_TIMEOUT`, default
  15m) or the health check (`OS_HEALTH_DEADLINE`, default 300 seconds, each probe limited to 10 seconds), the
  script prints a diagnosis and exits non-zero. The diagnosis lists the pods that are not Ready, any image pull
  problems with the image name, and the last warning events.
  - `ImagePullBackOff` for a `sovereign-os/...` or `ghcr.io/...` image means the image was not built or loaded.
    Run `./scripts/os up` again, or check `docker images` and `docker exec sovereign-os-control-plane crictl images`.
  - `ImagePullBackOff` for a public image means the node cannot reach the registry. See the proxy section above.
  - `Pending` with "Insufficient memory" means the Docker VM is too small. Give it more memory, or free disk with
    `docker builder prune -af`.
