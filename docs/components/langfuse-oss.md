<!-- SPDX-License-Identifier: Apache-2.0 -->
# Langfuse images without the Enterprise Edition (`langfuse-oss`)

**Owner decision 2026-11-24 ("B"):** the OS runs its own Langfuse web and worker images, built from
source **without any code under the Langfuse Enterprise License**. Langfuse's root `LICENSE` puts
`ee/`, `web/src/ee/` and `worker/src/ee/` under that licence; everything else is MIT. The upstream images
(`langfuse/langfuse`, `langfuse/langfuse-worker`) contain the EE code compiled, and Langfuse publishes no
OSS-only build (container image licence audit 2026-11-24, PR #351).

The EE code is **deleted**, not disabled. Where Langfuse's MIT code imports an EE module, an **original
stub** of the same name says the feature is unavailable (below). Nothing in this repository or in the
images is copied from, adapted from or written after the EE code. The stubs were written from the import
statements and call sites in Langfuse's MIT code and the exported names and parameter lists of the EE
modules (the import signature), never from their bodies.

| | |
|---|---|
| Images | `ghcr.io/data-masterclass/sovereign-os/langfuse-oss-web`, `…/langfuse-oss-worker` (private org packages), built by `build-images.yml` (tags `langfuse-oss-web-v<version>`, `langfuse-oss-worker-v<version>`) |
| Source | `images/extensions/langfuse-oss/`: `Dockerfile` (targets `web`, `worker`), `prepare-source.mjs`, `overlay/` (the stubs), `verify-build.sh`, `build-tools/` + `prisma-cli/` (lockfiles) |
| Upstream | Langfuse **3.194.1**, git commit `a75766c15365b668c8517cbfea2e6347d465ce8d` (checked after fetch) |
| Licence gate | `node scripts/license-gate-image.mjs --image <ref> --scope langfuse-oss --strict --rootfs --node-modules …`, in `license-gate.yml` (job `langfuse-oss-image`, with the upstream images as negative twins) and before every push in `build-images.yml` |
| Parity probe | `scripts/tests/langfuse-oss/run.sh` (both image pairs on fresh backends, same probe, migrations compared) |
| Chart | `langfuse.langfuse.{web,worker}.image` (by digest) and `langfuseBasePath` in `charts/sovereign-agentic-os/values.yaml`; rollback `deploy/overlays/langfuse-upstream-image.yaml`, return `deploy/overlays/langfuse-oss-image.yaml` |
| Chart test | `scripts/tests/langfuse-oss-chart.test.sh` |

## How the image is built

1. **Source** (`source` stage): `git fetch --depth 1` of the pinned commit; the build fails unless
   `HEAD` is exactly that commit and `web/package.json` says 3.194.1.
2. **`prepare-source.mjs`**:
   - checks that the root `LICENSE` still names exactly `ee/`, `web/src/ee/`, `worker/src/ee/` (a change in
     Langfuse's licensing fails the build until it is re-reviewed);
   - collects **fingerprints**: string literals of 24+ characters from the EE files that occur nowhere in
     the MIT source (341 at 3.194.1). They stay inside the build stages and are used once, in step 5;
   - **deletes** the three EE directories, and the 13 MIT test files that import from them (they test EE
     code; tests are not shipped);
   - copies `overlay/` (the stubs, one replaced MIT file) and **rewrites** every EE import to the stub of
     the same name: `@/src/ee/…` → `@/src/features/oss-unavailable/…` (web, 38 files),
     `../ee/…` / `./ee/…` → `oss-unavailable/…` (worker, 5 files);
   - removes the `@langfuse/ee` workspace package from `web/package.json`, `pnpm-workspace.yaml` and its
     two entries in `pnpm-lock.yaml` (each edit must apply exactly once);
   - sets `images: { unoptimized: true }` in `web/next.config.mjs` (sharp, below);
   - **fails** if any EE directory, EE import or `@langfuse/ee` reference is left.
3. **Upstream's build**: `turbo prune`, `pnpm install --frozen-lockfile` (upstream's lockfile minus the
   `@langfuse/ee` entries), `turbo run build`, the worker's `pnpm deploy --prod`, golang-migrate v4.19.1
   built from source with only the ClickHouse driver. The web build runs with
   `NEXT_PUBLIC_BASE_PATH=/tools/langfuse`.
4. **No sharp/libvips**: `@img/sharp-*` (libvips is LGPL-3.0-or-later) is removed from the output. No
   Langfuse code calls sharp; with `images.unoptimized` Next.js never loads it.
5. **`verify-build.sh`** fails the build if the built output (web `.next/static` and `.next/standalone`,
   the deployed worker) has an EE directory, libvips, or any EE fingerprint. Fingerprints that also occur
   in third-party packages installed before the build cannot tell EE apart and are dropped first (0 at
   3.194.1).
6. **Runtime**: `node:24-alpine` by digest, `dumb-init` (the upstream entrypoints `./web/entrypoint.sh`
   and `./worker/entrypoint.sh`, unchanged: Postgres and ClickHouse migrations, then the server), UID/GID
   1001, no npm/corepack/yarn in the final images. The worker defaults the EE queue consumers to off
   (`ENV`); the stubs throw if one is switched on anyway.

**Pinned inputs**: the git commit; both base images by digest; `turbo`, `pnpm` and the Prisma CLI with
`npm ci` from committed lockfiles (sha512 integrity); Langfuse's own dependencies from its lockfile with
`--frozen-lockfile`; golang-migrate by module version (Go checksum database). Like upstream, the Prisma
engines are downloaded by `@prisma/engines` at install time from `binaries.prisma.sh` and checked against
the `.sha256` published there (the litellm-oss doc, "Prisma engines", explains the trust model).

## Stubs

All under `images/extensions/langfuse-oss/overlay/`, Apache-2.0, our code. Every one keeps only the
exported name and parameter list Langfuse's MIT code uses.

| EE module (removed) | Stub behaviour | Used by (MIT code) |
|---|---|---|
| `admin-api/server/adminApiAuth` | every admin check refuses: `/api/admin/*` and tRPC `adminProcedure` answer **403** | admin routes, `server/api/trpc.ts` |
| `admin-api/server/{memberships,organizations,projects,…}` (11 modules) | handlers answer **403** "not available in this Langfuse build"; the query validators parse the ids themselves | org-scoped public API (`/api/public/organizations/*`, `POST /api/public/projects`, `/api/public/projects/{id}` writes, project API keys and memberships), admin API |
| `billing/*` (routers, Stripe service and webhook, `isCloudBilling`, catalogue) | empty tRPC routers; cloud billing never enabled; the webhook route answers 403; no Stripe product maps to a plan | `server/api/root.ts`, `organizationRouter`, `getPlan`, settings pages, payment banner |
| `billing/components/SupportOrUpgradePage` | a notice that the feature is not available | pages shown when the plan lacks an entitlement |
| `audit-log-viewer/*`, `sso-settings/*` | a notice | project and organisation settings |
| `in-app-agent/*` | the provider renders its children, the hook says unavailable, the route answers 403, empty router; the sidebar button file (MIT) is replaced and renders nothing | `_app.tsx`, sidebar, `app/api/in-app-agent/route.ts` |
| `multi-tenant-sso/*` | no per-domain SSO provider, no dynamic providers, `isAnySsoConfigured()` false, config route 403, empty router | `server/auth.ts`, sign-in and sign-up |
| `ui-customization/*` | never a customization (callers use Langfuse's defaults), `ProductModule` is a plain string, empty router | logo, navigation, API-key forms, env snippets |
| `verified-domains/*` | empty router | `server/api/root.ts` |
| worker `dataRetention`, `cloudUsageMetering`, `cloudSpendAlerts`, `usageThresholds`, `meteringDataPostgresExport` | throw `OssUnavailableError` (the consumers are off by default, so they never run) | `worker/src/app.ts`, `worker/src/queues/*` |

`packages/shared/src/server/ee/` (licence check, ingestion masking) is **outside** the directories the root
`LICENSE` names, so it is MIT and stays. Without a licence key its features are off, as upstream.

**What the OS loses: nothing it uses.** The OS uses project API keys, OTel and ingestion, trace and
observation reads, metrics, scores and the trace UI (`docs/components/langfuse.md`). None of these touches
EE code. The admin API, organisation API keys, SSO configuration, audit logs, data retention, UI
customization and the in-app agent were all EE features that need a licence the OS does not have, so
upstream refuses them as well (with its own wording).

## Base path

The web image is built with `NEXT_PUBLIC_BASE_PATH=/tools/langfuse` (the same for every customer; Next.js
`basePath` is build-time). It serves every page, asset and API route under that path. This is what lets
the OS serve the console through its same-origin proxy (`os-ui/core/infra/tool-proxy.ts`,
`docs/ops/tool-consoles.md`). Every caller uses the path:

| Caller | Setting |
|---|---|
| os-ui `LANGFUSE_URL` (SDK export, scores, trace/observation/metrics reads, the server-side NextAuth sign-in) | `osUI.langfuseUrl` + `langfuseBasePath` |
| LiteLLM `LANGFUSE_HOST` (`langfuse_otel`) | `langfuseInit.host` + `langfuseBasePath` (`soa.langfuseUrl`) |
| OTel collector Langfuse exporter (off by default) | the same + `/api/public/otel` |
| Web liveness / readiness probes | `/tools/langfuse/api/public/health`, `…/ready` (subchart values) |
| `NEXTAUTH_URL` | `<public address>/tools/langfuse` (subchart value, per profile; dev: `https://langfuse.dev.<domain>/tools/langfuse`, checked by the operator-route guard) |
| "Open in Langfuse" links (`LANGFUSE_CONSOLE_URL`) | console address + `langfuseBasePath` |

**STACKIT profile:** `litellm-credentials` comes from the secret store there, and the chart's
`LANGFUSE_HOST` line is not rendered. The value in the store must also end with `/tools/langfuse`
(`http://agentic-os-langfuse-web:3000/tools/langfuse`). Change it together with the rollout, or LiteLLM's
generations stop reaching Langfuse (HTTP 404).

The tool-console registry derives the Langfuse entry from `LANGFUSE_URL`
(`langfuseTool()` in `tool-proxy.ts`). When the URL ends with `/tools/langfuse`, the console is proxied
like Dagster and LiteLLM: the origin is the upstream and the prefix is forwarded. Otherwise (the upstream
image at the site root) it stays an own tab and reports "pending", as before.

## Licences in the images

- Langfuse (MIT) with its licence statement: `/usr/share/licenses/langfuse-oss/LANGFUSE-LICENSE`; our
  notice: `/usr/share/licenses/langfuse-oss/LICENSE-NOTICE.md`.
- Every npm package keeps its own licence file in `node_modules/`. The image gate judges every one of
  them against `licenses/policy.json` (`--strict`: no ratchet). Attributions:
  `licenses/notices/langfuse-oss-image.md` (generated with `--write-notices`).
- Alpine base packages are not scanned by the image gate (the same for every image of this repo).

## Evidence

See the PR that introduced this directory for the run outputs (licence gate on both images, negative
twins, parity probe, migrations).

## Rollout and rollback

- **Dev first**, as always; production with the next release after the owner has tested dev.
- Production derives its values from the live release (`scripts/deploy.sh`). If the live release pins
  the Langfuse images, deploy once with `VALUES_OVERLAY=deploy/overlays/langfuse-oss-image.yaml`.
- **Before** the first deploy on STACKIT: update `LANGFUSE_HOST` in the secret store (see "Base path").
- **Rollback** (image only; the same Langfuse version and migrations, no data change):
  `VALUES_OVERLAY=deploy/overlays/langfuse-upstream-image.yaml scripts/deploy.sh …`. On dev also pass
  `--set langfuse.langfuse.nextauth.url=https://langfuse.dev.<domain>`. On STACKIT set `LANGFUSE_HOST` back.
- Pulling the private org packages needs `registry-pull-secret` in the namespace, which dev and
  production already have. The chart passes it to both Langfuse pods (`langfuse.langfuse.image.pullSecrets`).

## Bumping Langfuse

1. Set `LANGFUSE_VERSION` / `LANGFUSE_COMMIT` in the Dockerfile and re-read the root `LICENSE`.
2. Build. `prepare-source.mjs` fails if the EE layout or an import changed. A new EE import needs a stub
   of the same name, written from the import signature and the MIT call sites only. A changed edit target
   (lockfile, next.config) fails the exact-once edit.
3. Run the image gate on both images (`--write-notices licenses/notices/langfuse-oss-image.md`), then
   `scripts/tests/langfuse-oss/run.sh` against the new upstream digests (`UP_WEB`, `UP_WORKER`).
4. Tag `langfuse-oss-web-v<version>-soa.<n>` and `langfuse-oss-worker-v<version>-soa.<n>`; pin both digests
   in `values.yaml` and `deploy/overlays/langfuse-oss-image.yaml`; update the rollback overlay's digests.
