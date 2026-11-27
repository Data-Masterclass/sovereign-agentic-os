# Container image licence audit, 2026-11-24

This audit covers every container image (containers and initContainers) running in namespace
`agentic-os` on prod and dev on 2026-11-24. It also covers the new gateway image
`litellm-oss:1.109.1-soa.4`, for comparison. Each image is judged against the repo's licence policy
(`licenses/policy.json`, policy of 2026-11-22).

**Coverage is partial.** 11 of the 33 distinct images were scanned completely: the repo gate plus a
full-filesystem SBOM. For one more, Langfuse web, only the layer holding the shipped client bundle was
read. The rest could not be fetched in this run. The workstation's network connection collapsed while
the run was going: Docker Hub and ghcr.io downloads fell to about 0.1 MB/s, then failed with
`read: can't assign requested address`. About 7.5 GB of images were still waiting. Those rows are marked
**not scanned**. Their verdicts are provisional and rest on the repo's own component records and the
upstream sources. The method below can be re-run unchanged on a machine with normal bandwidth, for
example a CI runner.

## Verdict summary

| Verdict | Images |
|---|---|
| **must-fix** | `litellm-database` 1.109.1 (proprietary `litellm-enterprise` inside; still running on prod and dev), `minio` (AGPL-3.0, forbidden by policy; recorded as "dev-only, never bundled" but running on prod and dev), `langfuse` / `langfuse-worker` (EE code under the Langfuse Enterprise License is in the images; the repo record says it is not; owner decision plus config change needed, see the Langfuse section) |
| **exception** (a GPL program, needs a reviewed `separate-program` entry that does not exist yet) | `busybox` 1.28 / 1.36 / latest (initContainers), `egress-proxy` (tinyproxy, GPL-2.0-or-later) |
| **exception** (covered by existing reviewed entries) | `litellm-oss` 1.109.1-soa.4 (gate PASS, `--strict`), `git-http` / `git-daemon` (git, GPL-2.0, excepted as `separate-program`) |
| **clean** (app level) | `valkey`, `victoria-logs`, `victoria-metrics`, `cert-manager-acmesolver` (dev, transient), `curl` (see note: the `curl` licence id is not in `allow`) |
| **not scanned** (provisional verdict in the table) | `opa`, `web-fetch`, `otel-collector`, `query-tool`, `os-ui` (prod and dev), `data-runner`, `aws-cli`, `postgres` 17 and 14.6, `clickhouse`, `dagster`, `polaris`, `polaris-admin-tool`, `trino`, `opensearch`, `docling` |

## Results per image

Digests are the `imageID`s reported by the kubelet (`status.containerStatuses[].imageID`), and every
image was fetched by that digest for platform `linux/amd64`. "Gate" is
`scripts/license-gate-image.mjs`. "n/a" means the image has no `python` interpreter, so the gate cannot
read its inventory and syft plus the policy engine were used instead (see Method). "Base-OS copyleft"
lists the GPL/LGPL/MPL distro packages syft found. These are mere aggregation and are summarised only.

| Image | Env | Digest | Main component licence | Findings (app level) | Base-OS copyleft (summary) | Verdict |
|---|---|---|---|---|---|---|
| `ghcr.io/data-masterclass/sovereign-os/litellm-oss:1.109.1-soa.4` (comparison, not yet deployed) | — | `sha256:26851caf…64b0a5` | MIT (LiteLLM core) | Gate `--scope litellm-oss --strict`: **PASS**. 1188 components checked (python 134, embedded 1052, npm 2). No `litellm_enterprise` distribution, module or path. 4 copyleft deps pass through reviewed image exceptions (`unmodified-not-linked`): psycopg 3.3.6 (LGPL-3.0-only), orjson 3.13.0, tqdm 4.67.3, certifi 2026.10.19 (MPL-2.0). Without `--scope`, psycopg fails, as designed. Licence-text markers: only `/usr/share/common-licenses/AGPL-3.0` (Debian `base-files` text, not a component) and our own `LICENSE-NOTICE.md`. | Debian 13: 98 packages, 26 GPL/LGPL (e.g. `tar`, `grep`, `passwd`, `libgmp10`, `libseccomp2`) | exception (reviewed) |
| `ghcr.io/berriai/litellm-database:1.109.1` | prod, dev | `sha256:932c5444…96986` | MIT core **+ proprietary `litellm-enterprise` 0.1.82** | Not re-scanned (fetch failed). Already documented in `docs/components/litellm-oss.md`: the image ships `litellm-enterprise` (`LicenseRef-Proprietary`) and the upstream `/app/enterprise/` tree. The gateway is still on this image in both clusters (pods `agentic-os-litellm`, `litellm-premigrate-1-109` / `db-migrate`). `values.yaml` on main already pins `litellm-oss`. | Wolfi (Chainguard) | **must-fix** |
| `ghcr.io/aborek/sovereign-os/minio` (moved 2026-11-27 to the private `ghcr.io/data-masterclass/sovereign-os/minio`, same digest) | prod, dev | `sha256:1887982b…bb23a7` | **AGPL-3.0** (Chainguard community build of MinIO, ghcr mirror) | Not scanned (fetch failed). AGPL is in `forbid` ("never allowed, never excepted"). `licenses/components.tsv` (`bundled=no`) and `THIRD-PARTY-LICENSES.md` describe MinIO as a "local dev-only stand-in, never bundled", but it runs on prod and dev, and `components/minio/UPSTREAM.md` says "the OS ships it". The gate does not catch this because the manifest row is `bundled=no`. | Wolfi | **must-fix** |
| `langfuse/langfuse:3.194.1` | prod, dev | `sha256:571446cb…ce1ee18` | MIT core **+ EE code under the Langfuse Enterprise License** | Layer `sha256:b717409e…` (`COPY /app/web/.next/static`) read in full: the compiled client bundle contains code from `web/src/ee/features/` (see the Langfuse section). The `org.opencontainers.image.licenses` label is `NOASSERTION`. Rest of the image (standalone server, `node_modules`) not scanned. | Alpine (node) — not scanned | **must-fix** (doc + config), then owner exception |
| `langfuse/langfuse-worker:3.194.1` | prod, dev | `sha256:90df7fbd…e601f8` | MIT core **+ EE code** | Not scanned (fetch failed). By the upstream build (`worker/Dockerfile`: `COPY /prod/worker ./worker`, `tsc` output), it contains `worker/src/ee/*` compiled, and `worker/src/app.ts` imports it unconditionally. | Alpine — not scanned | **must-fix** (doc + config), then owner exception |
| `ghcr.io/aborek/sovereign-os/git-http:1.0.0` | prod, dev | `sha256:598ac199…6f38` | GPL-2.0-only (git) | No app-ecosystem packages; git comes from the Alpine package. Covered by the existing `component git … separate-program` exception. | Alpine: 35 packages, 16 GPL/LGPL/MPL (`git`, `git-daemon`, `busybox`, `gdbm`, `libidn2`, …) | exception (reviewed) |
| `ghcr.io/aborek/sovereign-os/git-daemon:1.0.0` | prod, dev | `sha256:a74a6970…bd88` | GPL-2.0-only (git) | Not scanned (fetch failed). Same build family as `git-http`, covered by the same exception. | — | exception (reviewed), provisional |
| `ghcr.io/aborek/sovereign-os/egress-proxy:0.1.0` | prod, dev | `sha256:8426ee9d…f9ee` | **GPL-2.0-or-later** (tinyproxy) | tinyproxy is the image's whole purpose: a separate program the chart runs as its own process. No entry in `licenses/exceptions.json`, `components.tsv` or the notices files. | Alpine: 16 packages, 10 GPL/LGPL/MPL (`busybox`, `apk-tools`, …) | exception (entry missing) |
| `busybox:1.36` | prod, dev | `sha256:73aaf090…1662` | **GPL-2.0-only** (BusyBox) | initContainer `wait-for-clickhouse` (Langfuse web and worker). No exception entry. | — (single static binary) | exception (entry missing) |
| `busybox:latest` (1.38.0) | prod | `sha256:a46257e0…fa4` | **GPL-2.0-only** | initContainers `sysctl`, `fsgroup-volume` (OpenSearch chart). Unpinned tag `latest`. | — | exception (entry missing) |
| `docker.io/busybox:1.28` | prod, dev | `sha256:141c253b…7d47` | **GPL-2.0-only** | initContainer `init-user-deployment-sovereign` (Dagster chart). | — | exception (entry missing) |
| `valkey/valkey:8.1-alpine` (8.1.8) | prod, dev | `sha256:77643d15…baa75` | BSD-3-Clause | No app-level findings (syft finds the `valkey-server` binary only; licence from upstream). | Alpine: 21 packages, 13 GPL/LGPL/MPL | clean |
| `victoriametrics/victoria-logs:v1.54.0` | prod | `sha256:ee4e820c…1dfe` | Apache-2.0 | 17 Go modules, all permissive (resolved via deps.dev). `valyala/gozstd` reports `MIT, GPL-2.0, BSD-3-Clause`: the GPL-2.0 is the bundled zstd, which is dual "BSD-3-Clause OR GPL-2.0", so BSD applies. | distroless: `netbase` only | clean |
| `victoriametrics/victoria-metrics:v1.156.0` | prod | `sha256:da8a90ac…66970` | Apache-2.0 | 20 Go modules, permissive. Same `gozstd` note. | Alpine: 16 packages, 10 GPL/LGPL/MPL | clean |
| `quay.io/jetstack/cert-manager-acmesolver:v1.16.1` | dev (transient ACME solver) | `sha256:14304826…8e` | Apache-2.0 | 41 Go modules, 39 permissive. 2 resolve to nothing (cert-manager's own modules, Apache-2.0). | distroless: `netbase` | clean |
| `curlimages/curl:8.8.0` | prod | `sha256:73e4d532…bcd` | curl (MIT-style) | curl's own licence (SPDX `curl`) is not in `policy.json` `allow`. It would read as **unknown** in the gate. It needs an alias or allow decision. No copyleft. | Alpine: 32 packages, 14 GPL/LGPL/MPL | clean (policy gap: add `curl`) |
| `openpolicyagent/opa:1.22.4` | prod, dev | `sha256:ff50f503…acccf` | Apache-2.0 | Not scanned. | Chainguard static | not scanned (provisional clean) |
| `otel/opentelemetry-collector-k8s:0.165.0` | prod | `sha256:ce55d0a3…829f` | Apache-2.0 | Not scanned. | — | not scanned (provisional clean) |
| `ghcr.io/aborek/sovereign-os/web-fetch:0.1.0` | prod, dev | `sha256:1487d74f…686d` | ours (Apache-2.0) + Python deps | Not scanned. Has Python, so the gate applies directly. | — | not scanned |
| `ghcr.io/aborek/sovereign-os/query-tool:0.6.2` | prod, dev | `sha256:3abffd09…8976` | ours + DuckDB (MIT) | Not scanned. Has Python, so the gate applies. | — | not scanned |
| `ghcr.io/aborek/sovereign-os/data-runner:0.2.2` | prod, dev | `sha256:8f7b8a32…e482` | ours + Python deps | Not scanned. | — | not scanned |
| `ghcr.io/data-masterclass/sovereign-os/os-ui:0.9.34` | prod | `sha256:a36e97c7…73ba` | ours (Apache-2.0); npm deps gated from the lockfile by `license-check.sh` | Not scanned as a built image. | — | not scanned |
| `ghcr.io/data-masterclass/sovereign-os/os-ui:main-2aa16d97…` | dev | `sha256:e57688b9…12f7` | as above | Not scanned. | — | not scanned |
| `ghcr.io/data-masterclass/sovereign-os/dagster:0.4.1` | prod, dev | `sha256:468a8fe7…343d` | Apache-2.0 (Dagster, dbt-core) | Not scanned. Has Python, so the gate applies. | — | not scanned |
| `ghcr.io/data-masterclass/sovereign-os/docling:1.38.2-1` | prod, dev | `sha256:edcb61bd…2a53` | MIT (docling-serve) | Not scanned (2.4 GB). Base is a CentOS/UBI-family image (label `org.label-schema.license: GPLv2` refers to the base). Has Python, so the gate applies. | — | not scanned |
| `amazon/aws-cli` (2.31.13) | prod | `sha256:e14216fb…7180a` | Apache-2.0 | Not scanned (bundled Python under `/usr/local/aws-cli`, not on `PATH`). | Amazon Linux | not scanned (provisional clean) |
| `apache/polaris:1.1.0-incubating` | prod, dev | `sha256:27d081a5…cdf9` | Apache-2.0 | Not scanned. The base image is Red Hat UBI (UBI EULA, freely redistributable). | UBI | not scanned (provisional clean) |
| `apache/polaris-admin-tool:1.1.0-incubating` | prod | `sha256:7cdd9216…c94e` | Apache-2.0 | Not scanned. UBI base. | UBI | not scanned (provisional clean) |
| `trinodb/trino:476` | prod, dev | `sha256:00125e40…bbee` | Apache-2.0 | Not scanned. UBI base. | UBI | not scanned (provisional clean) |
| `opensearchproject/opensearch:3.7.0` | prod, dev | `sha256:44ba7ea5…c9` | Apache-2.0 | Not scanned. | — | not scanned (provisional clean) |
| `clickhouse/clickhouse-server:24.8` (24.8.14.39) | prod, dev | `sha256:1ffa82ed…597b` | Apache-2.0 | Not scanned. Ubuntu 20.04 base. | Ubuntu | not scanned (provisional clean) |
| `postgres:17` | prod, dev | `sha256:5c855ad7…1c5e` | PostgreSQL | Not scanned. Debian base. | Debian | not scanned (provisional clean) |
| `docker.io/library/postgres:14.6` | prod, dev | `sha256:f565573d…a647` | PostgreSQL | Not scanned. Used only as the `check-db-ready` initContainer (Dagster chart). | Debian | not scanned (provisional clean) |

## Langfuse: the `ee` question

**Licence header of the EE folder.** From `ee/LICENSE` at tag `v3.194.1` (commit `a75766c`):

> Langfuse is an open core project. Langfuse's core is permissively licensed (MIT license). Certain parts
> of the periphery of Langfuse are commercially licensed and governed by this Enterprise License. […]
>
> Langfuse Enterprise license (the "Enterprise License" or "EE license") […] This software and associated
> documentation files (the "Software") may only be used, if you (and any entity that you represent) have
> agreed to, and are in compliance with, the applicable Langfuse Terms of Service […] and otherwise have
> a valid Langfuse Enterprise License. […] you may copy and modify the Software for development and
> testing purposes, without requiring a subscription. […] Subject to the foregoing, it is forbidden to
> copy, merge, publish, distribute, sublicense, and/or sell the Software.

The root `LICENSE` applies this licence to "all content that resides under the `ee/`, `web/src/ee/`,
and/or `worker/src/ee/` directories". Everything else is MIT. A fourth directory,
`packages/shared/src/server/ee/` (ingestion masking, licence check), is not named in that list.

**Which EE paths are in the source at the tag:**
- `ee/`: the package `@langfuse/ee` (`ee-license-check`, `env.ts`)
- `web/src/ee/features/`: `admin-api`, `audit-log-viewer`, `billing`, `in-app-agent`,
  `multi-tenant-sso`, `sso-settings`, `ui-customization`, `verified-domains`
- `worker/src/ee/`: `cloudSpendAlerts`, `cloudUsageMetering`, `dataRetention`,
  `meteringDataPostgresExport`, `usageThresholds`
- `packages/shared/src/server/ee/`: `ingestionMasking`, `licenseCheck`

**Which EE code is in the deployed image.** The images ship compiled output, not the `ee/` source
directories. That output still contains EE code. From the `langfuse:3.194.1` layer `sha256:b717409e…`
(`/app/web/.next/static`, read in full):

| String found in the shipped chunk | Chunk | Source file at v3.194.1 |
|---|---|---|
| "Add the DNS TXT record shown in the table, then click Verify." | `chunks/2-hdorufkldgd.js` | `web/src/ee/features/verified-domains/components/VerifiedDomainsSettings.tsx` |
| "The actor within Langfuse who performed the action." | `chunks/17g9u8bmlr-f0.js`, `chunks/1f3jxq-h_h2a-.js` | `web/src/ee/features/audit-log-viewer/AuditLogsTable.tsx` |
| "Spend alert created successfully" | `chunks/2-hdorufkldgd.js` | `web/src/ee/features/billing/components/SpendAlerts/SpendAlertDialog.tsx` |
| "Failed to start checkout session" | `chunks/2-hdorufkldgd.js` | `web/src/ee/features/billing/components/BillingSwitchPlanDialog.tsx` |

The server bundle (`.next/standalone`, including `@langfuse/ee` in `node_modules`) and the worker's
`worker/dist/ee/` were not fetched. The upstream build includes them: both Dockerfiles run
`turbo prune` plus a full build with no EE exclusion.

**Are the EE imports guarded or required?** They are required at build time and gated at run time.
- In `web/src`, 55 non-EE files import from `@/src/ee/...` statically, and `web/package.json` depends on
  `"@langfuse/ee": "workspace:*"`.
- `worker/src/app.ts` and `worker/src/queues/*` import `../ee/...` statically: data retention,
  cloud usage metering, spend alerts, usage thresholds, the metering export.
- Removing the EE directories breaks the build. There is no build flag and no `NEXT_PUBLIC_*` switch
  that drops them.
- At run time, features are gated by `isEnterpriseLicenseAvailable()` (true only when
  `NEXT_PUBLIC_LANGFUSE_CLOUD_REGION` is set or `LANGFUSE_EE_LICENSE_KEY` starts with `langfuse_ee_`)
  and by the plan entitlements. On prod neither variable is set in the web or worker Deployment, and
  the `langfuse-init` Secret holds neither key (checked by key name only).
- **One exception to the runtime gating:** the worker registers the EE data-retention queue whenever
  `QUEUE_CONSUMER_DATA_RETENTION_QUEUE_IS_ENABLED` is `"true"`, and that is the default
  (`worker/src/env.ts`). So `worker/src/ee/dataRetention/handleDataRetentionSchedule.ts` runs on a
  schedule with no licence key. It finds nothing to do unless a project has `retentionDays > 0`, but
  EE code does execute. Cloud usage metering also defaults to enabled, but it additionally requires
  `STRIPE_SECRET_KEY`, which is not set.

**Is there a documented OSS-only build?** No. langfuse.com/docs/open-source says the EE modules "are
shipped as source code, but require a license key to run", that "they are optional; the core works
100% without them", and that "you can run the core image without a key without running EE code".
It names no separate OSS image or build. The OSS deployment is the same image with no key.

**What this means for the OS:**
1. `licenses/components.tsv` says "Langfuse (core) … /ee modules NOT shipped". That is not accurate:
   the upstream images contain compiled EE code.
2. The OS does not redistribute the images. The chart pulls `langfuse/langfuse` from Docker Hub, so the
   EE licence's ban on distribution is not triggered by us. The EE features stay off without a key, and
   Langfuse's own FAQ allows running the core image without one.
3. To match "no EE code executes", set `QUEUE_CONSUMER_DATA_RETENTION_QUEUE_IS_ENABLED=false` and
   `QUEUE_CONSUMER_CLOUD_USAGE_METERING_QUEUE_IS_ENABLED=false` on the worker.
4. The OS has no OSS-only image to switch to. Removing the EE code entirely would mean maintaining a
   patched build, because the static imports would have to be stubbed. The alternative is an owner
   exception that records "upstream image used unmodified, EE features never licensed or enabled".
   The policy has no category for proprietary code that is shipped but inactive. LiteLLM's equivalent
   was resolved by building our own image, and that was possible only because LiteLLM guards its
   enterprise imports.

## Must-fix list

1. **LiteLLM gateway: roll out `litellm-oss`.** Prod and dev still run
   `ghcr.io/berriai/litellm-database:1.109.1`, which contains the proprietary `litellm-enterprise`.
   `values.yaml` on main already pins `litellm-oss:1.109.1-soa.4@sha256:26851caf…`, and that image
   passes the gate (`--strict --scope litellm-oss`). Deploying it, dev first, closes this.
2. **MinIO (AGPL-3.0) runs in prod and dev.** The policy forbids AGPL without exception. The records
   contradict each other: `components.tsv` (`bundled=no`, "dev-only") and `THIRD-PARTY-LICENSES.md`
   say one thing, the chart and `components/minio/UPSTREAM.md` another. Either replace MinIO with the
   managed object storage or an Apache-2.0 store, or the owner changes the policy. In both cases,
   correct the manifest so the gate sees the component.
3. **Langfuse EE.**
   - Correct `components.tsv` (EE code is in the images).
   - Set the two worker queue flags above to `false`.
   - Record an owner decision: an exception for "unmodified upstream image, EE not licensed or enabled",
     or a patched build.
4. **GPL programs without an exception entry:** BusyBox (3 initContainer images; `busybox:latest` is
   also unpinned) and tinyproxy (`egress-proxy`). Both are separate programs, like git. Add reviewed
   `separate-program` entries plus attribution, or replace the BusyBox initContainers with images the
   chart already ships.
5. **Policy gap:** the `curl` licence id is not in `allow`, so curl would fail the gate as unknown.
   Add it to `allow` (permissive, MIT-style) or as an alias.
6. **Finish the scan** of the "not scanned" rows with the same method on a machine with normal
   bandwidth. Priority: `os-ui`, `dagster`, `docling`, `query-tool`, `web-fetch`, `data-runner` (our
   own images, Python, so the gate applies directly), then the Langfuse server bundle and worker.

## Method

1. **Inventory (read-only on both clusters).**
   `kubectl get pods -n agentic-os -o json` on prod (context `dmagenticos`) and on dev
   (`KUBECONFIG=~/.kube/dmagosdev.yaml`). The spec image of every container and initContainer was
   joined with its status `imageID`. This gave 30 distinct digests on prod and 24 on dev: 33 distinct
   images including the comparison image. Nothing in either cluster was changed, apart from listing
   Secret key names; no values were printed.
2. **Fetch by digest.** Each image was fetched as `<repo>@sha256:<digest>` for `linux/amd64` (the
   platform of the cluster nodes). This was done with `docker pull --platform linux/amd64` or with
   `crane pull --platform linux/amd64` plus `docker load`. After each scan the image and tarball were
   removed, and `docker system df` was checked between images.
3. **Repo gate.** `node scripts/license-gate-image.mjs --image <ref>` as documented in the script.
   It runs `scripts/lib/image-inventory.py` inside the image and applies `licenses/policy.json`, the
   exceptions, the overrides and the ratchet. For `litellm-oss` the CI invocation was used:
   `--scope litellm-oss --strict`. The gate needs a `python` interpreter in the image. For images
   without one, it exits 2 and step 4 is the judgement.
4. **Full-filesystem SBOM.** `syft` 1.46 (CycloneDX) over the same image. Every component's declared
   licence was judged with the repo's own engine (`checkAll` / `evaluateExpression` from
   `scripts/lib/license-policy.mjs`, same policy and exceptions). Components were split by package
   type: `deb`/`apk`/`rpm` count as base-OS, everything else as app level. Licences syft cannot read
   (Go modules, some wheels) were resolved through the deps.dev API and judged the same way. Every
   copyleft hit was reviewed by hand (e.g. `gozstd` dual licence). Attribution checks were not applied
   to third-party upstream images, because they ship their own notices.
5. **Proprietary markers.**
   - The file list of each image was searched for `ee/`, `enterprise/` and `litellm_enterprise` paths.
   - Every `LICENSE*`, `COPYING*` and `NOTICE*` file was searched for "Business Source License",
     "Server Side Public License", "Elastic License", "Redis Source Available", "GNU AFFERO",
     "Enterprise License", "Commercial License" and "LicenseRef-Proprietary".
6. **Langfuse.**
   - Read the upstream repository at tag `v3.194.1` (commit `a75766c`): `LICENSE`, `ee/LICENSE`, both
     Dockerfiles, and the import graph into the `ee` directories.
   - Read `https://langfuse.com/docs/open-source`.
   - Read the image config history and the `.next/static` layer of the deployed web image.
   - Checked the prod Deployments for `LANGFUSE_EE_LICENSE_KEY` and `NEXT_PUBLIC_LANGFUSE_CLOUD_REGION`
     (names only).
