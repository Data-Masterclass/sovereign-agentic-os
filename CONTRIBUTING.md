# Contributing to the Sovereign Agentic OS

Thanks for your interest in contributing! The core is **Apache-2.0** (see `LICENSE`).
Bundled third-party components keep their own licenses (see `THIRD-PARTY-LICENSES.md`);
please don't add a dependency whose license isn't on the allowlist
(`licenses/allowed-licenses.txt`) — CI enforces it (`.github/workflows/license-gate.yml`).

> **Status:** this is a **pre-beta / experimental test release**. Interfaces, chart values,
> and schema may change without notice.

## Contributor License Agreement (CLA) — required

Before we can accept your contribution, you must agree to the project **Contributor License
Agreement** in [`CLA.md`](CLA.md). The CLA lets **Borek Data Ventures UG
(haftungsbeschränkt)** — the project steward — accept your contribution into the
Apache-2.0 core **and** distribute it (including under the separate commercial Enterprise
Edition), while **you keep the copyright to your contribution**. It is a one-time agreement
per contributor.

How it works:

- On your **first pull request**, the CLA assistant will ask you to accept the CLA by
  commenting (e.g. `I have read the CLA Document and I hereby sign the CLA`). The bot records
  your acceptance so you only do this once.
- Organizations contributing on behalf of employees should use the **Corporate CLA** — open
  an issue and we'll arrange it.
- Read the full terms in [`CLA.md`](CLA.md) before signing. Not legal advice; if you're
  contributing on behalf of an employer, make sure you're authorized to.

We use a CLA (rather than a DCO) because this is an **open-core** project: a CLA gives the
steward the explicit right to relicense contributions into the commercial Enterprise Edition
while keeping the core open under Apache-2.0.

## Repository structure

Our code goes **only** in `os-ui/`, `images/`, `scripts/`, `tests/` and `charts/` — never the
repo root, never inside a bundled component's folder, and **no new top-level folders without
asking first**.

```
charts/        the umbrella Helm chart (components consumed as images/subcharts)
components/    one folder per bundled OSS component — integration only, see below
images/        our own Docker images (base/ + extensions/)
os-ui/         our own application code
deploy/ docs/ scripts/ seed/ tests/
licenses/ + THIRD-PARTY-LICENSES.md + NOTICE + sbom.cdx.json
```

### os-ui is a kernel plus thirteen tab modules

```
os-ui/core/<area>/   the kernel: auth, infra, kernel, mcp, models, policy, runtime, ui, …
os-ui/tabs/<tab>/    one per tab — a CLOSED set of 13
  lib/               tab logic
  ui/                tab-specific components
  mcp/               this tab's MCP tool handlers (each UI action should have an MCP twin)
  manifest.ts        the tab's routes, APIs, MCP tools, policies — the authoritative contract
  README.md          what the module is for, generated from its manifest
os-ui/app/           the route tree ONLY — thin pages importing from tabs/ and core/
```

The thirteen, a closed set. A fourteenth module, or tab code placed anywhere else, needs an
explicit decision first:

```
admin  agents  connections  dashboards  data  files  governance
home   knowledge  metrics  monitoring  software  workflows
```

`metrics` is the folder name; its user-facing label is **KPIs**. Folder names are stable,
labels are not — never rename a module to chase a label.

### Three rules the split exists to protect

1. **A tab imports only `@core/*` and itself.** A cross-tab need means the shared part belongs
   in `@core`.
2. **The kernel never imports a tab.** `@core` must not know its tabs exist.
3. **`components/` is upstream-only.** Only `UPSTREAM.md`, `LICENSE` and `README` belong there;
   our integration code goes in the chart or the owning tab.

### Bundled components

Never copy upstream source into this repo — components are consumed as **pinned images and
subcharts**. Adding or upgrading one requires, in the same pull request: a row in
`THIRD-PARTY-LICENSES.md`, the license text in `licenses/`, and a regenerated `sbom.cdx.json`.
Must modify upstream? Use `components/<name>/patches/*.patch`, applied at image build, and
prefer an upstream pull request.

**The one carve-out: `os-ui/vendor/`.** A small, attributed, licence-clean slice of permissively
licensed third-party SOURCE may be compiled into `os-ui` — today Apache Superset's pure ECharts
transformers, Apache-2.0 into Apache-2.0. That is a different thing from a bundled component: it is
not an image, not a subchart, and not separately redistributed. The rule above still governs
everything in `components/`. A vendored file must keep its upstream licence header **verbatim**
(never rewritten), carry a `Modified from <repo> <path> @ <40-char sha>` notice with a `Changes:`
list and an SPDX line, be recorded in `licenses/components.tsv`, `THIRD-PARTY-LICENSES.md`,
`NOTICE`, `sbom.cdx.json` and `os-ui/core/kernel/licenses.ts`, and import nothing. The hard
`VENDOR-LICENCE-HEADER` rule in `scripts/check-structure.mjs` enforces the header half; read
`os-ui/vendor/superset/README.md` before adding to it.

## Running the checks

```bash
node scripts/check-structure.mjs    # structure + file headers (a ratchet — see below)
npm --prefix os-ui test             # the unit suite
bash os-ui/scripts/gate.sh          # the regression gate
helm lint charts/sovereign-agentic-os -f values.local.yaml
```

**Changed a scaffold's dependencies?** New apps are seeded with a real `package-lock.json`, and
the committed lockfiles (`os-ui/tabs/software/lib/scaffolds/locks/`) are npm's own output — never
edit one by hand, and never write one any other way. Regenerate them (needs the npm registry),
then run the drift test, which fails while a scaffold manifest and its lockfile disagree:

```bash
node --experimental-strip-types os-ui/scripts/regen-scaffold-locks.mjs           # rewrite the lockfiles
node --experimental-strip-types os-ui/scripts/regen-scaffold-locks.mjs --check   # compare with a fresh resolution
cd os-ui && node --experimental-test-module-mocks --import ./scripts/test-setup.mjs \
  --test tabs/software/lib/scaffold-lock.test.ts
```

The drift test also holds every package the lockfiles resolve to Apache-2.0 / MIT / BSD / ISC,
with each exception named in the test (`LICENCE_EXCEPTIONS`). See "A generated app ships a real
lockfile" in `os-ui/ARCHITECTURE.md` for why the files are named `<family>.package-lock.json`.

`check-structure.mjs` is a **ratchet**: pre-existing violations are baselined in
`scripts/structure-baseline.json` and the counts may only go **down**. Pay one down, then run
it with `--baseline` to lock the new number in. It also requires a
`FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header on every source file, alongside the SPDX
header described under Pull requests.

**Before writing code, read [`os-ui/ARCHITECTURE.md`](os-ui/ARCHITECTURE.md)**, especially
"Things this codebase will punish you for". It records constraints that have each cost real
debugging time — a Next.js `route.ts` may export only its handlers, a test cannot import a
`.tsx`, and a fallback must never report success with substituted data.

## Operating this repo

- Local: `./scripts/os up | test | down`. A cluster: `./scripts/deploy.sh <version>`, which
  backs up first and aborts if the backup gate fails.
- **Never plain `tofu apply`** — always `-target=`.
- The Velero CRD is `backups.velero.io`, never `backup` (it collides with CloudNativePG's).
- **Never run a tree-wide script while another executes from the same checkout.** Rewriting a
  running shell script makes it resume mid-line; this once deleted a Dockerfile and committed
  the deletion.
- **Run `deploy.sh` directly, never through a pipe** (`| tail`): the pipeline's exit status
  masks a failed upgrade as success.
- **Stop Colima after building** (`colima stop`). The deploy's Docker build runs in a VM that
  reserves 14 GB; left running on a ~24 GB machine it starves everything else — including the
  next deploy's `kubectl` and Helm calls, which then time out.
- **Merge with "Rebase and merge", never squash.** A squash creates a commit absent from the
  branch's ancestry, so the next branch reports conflicts in every touched file.

## Images: build in CI

Building images on a laptop is the most expensive thing this repo asks of a maintainer: the
Colima VM reserves 14 GB on a 24 GB host, its DNS has failed mid-build twice, the host has
OOM-killed runs, and an emulated `linux/amd64` build blocks the machine for 10–15 minutes.
`.github/workflows/build-images.yml` builds the same Dockerfiles on an amd64 runner instead —
on a `os-ui-v*` / `git-http-v*` / `dagster-v*` tag, or by hand via **Run workflow** (inputs:
image, version). For `os-ui` it runs the same worker type-stripping smoke `deploy.sh` runs,
**before** it pushes.

Then deploy **with no local Docker at all**:

```bash
./scripts/deploy.sh --from-registry <version>   # verifies the tag, reads its digest, upgrades
./scripts/deploy.sh --verify-only <version>     # just prove the tag exists; touches no cluster
```

`--from-registry` keeps everything else identical: the pre-upgrade backup gate still aborts the
deploy, the values are still derived from the live release, and it is still one
`helm upgrade … --force-conflicts`. It needs `crane` (`brew install crane`) or `skopeo`; failing
both it falls back to the registry v2 API over `curl` (`gh auth token` for a private package,
and it tells a 401/403 — a token without `read:packages` — apart from a 404).

Either way the deploy **refuses** if the live release pulls os-ui from a different repository
than the image being deployed: a digest only exists inside one repository, so that mismatch
would be ImagePullBackOff on every pod. Pass `IMAGE_REPO` to say which namespace you mean.

**One decision is still open**, and nothing changes in production until it is made. Images live
at `ghcr.io/aborek/sovereign-os/*`, but this repository is `Data-Masterclass/…`, so a
workflow's built-in `GITHUB_TOKEN` can push to `ghcr.io/data-masterclass/*` and **cannot** push
to the `aborek` namespace. Pick one:

**Option A — move the namespace to `data-masterclass`.** No secret, no variable; the workflow
already defaults here. What must change is **package access, not the pull secret**: a
`kubernetes.io/dockerconfigjson` secret is keyed by registry **host** (`ghcr.io`), so the
existing credential already addresses the new namespace — but `GITHUB_TOKEN` creates the
package **private and scoped to this repository**, which that credential cannot read. So either
make the `data-masterclass/sovereign-os/os-ui` package public, or grant the account behind the
cluster's `ghcr.io` credential read access to it. And note the other images (`git-http`,
`git-daemon`, `dagster`, `minio`) stay in `ghcr.io/aborek` unless they are moved too, so for a
while **one credential must be able to read both namespaces**.

```bash
# once: make the new package readable by the cluster's ghcr.io credential (or public)
git tag os-ui-v<version> && git push public os-ui-v<version>
IMAGE_REPO=ghcr.io/data-masterclass/sovereign-os IMAGE_FROM_REGISTRY=1 ./scripts/deploy.sh <version>
```

**Option B — keep `ghcr.io/aborek/sovereign-os`.** Needs a classic PAT with `write:packages` on
the `aborek` account, stored as the repository secret `GHCR_TOKEN`, plus two repository
variables: `IMAGE_REPO_PREFIX=ghcr.io/aborek/sovereign-os` and
`IMAGE_REGISTRY_USER=aborek`. The second one matters — the registry login user must be the
**PAT's owner**, and the workflow otherwise uses `github.actor`, i.e. whoever pushed the tag.
Nothing about the cluster changes.

```bash
gh variable set IMAGE_REPO_PREFIX   --repo Data-Masterclass/sovereign-agentic-os --body ghcr.io/aborek/sovereign-os
gh variable set IMAGE_REGISTRY_USER --repo Data-Masterclass/sovereign-agentic-os --body aborek
gh secret   set GHCR_TOKEN          --repo Data-Masterclass/sovereign-agentic-os   # paste the PAT
git tag os-ui-v<version> && git push public os-ui-v<version>
IMAGE_FROM_REGISTRY=1 ./scripts/deploy.sh <version>
```

`IMAGE_REPO` defaults to `ghcr.io/aborek/sovereign-os` and is the only thing that moves the
chart's `osUI.image.repository`; a plain `./scripts/deploy.sh <version>` still builds locally
and deploys exactly as it always has.

## Pull requests

- Keep changes small and focused; explain **what** and **why**.
- **Never commit secrets** — secrets are external (see `README.md` → Conventions). Real
  credentials, tokens, kubeconfigs, or `.env` values must never be committed.
- Match the existing style; pin upstream chart versions and image digests.
- If you added source files or touched dependencies, run `scripts/add-spdx-headers.sh` and
  `scripts/license-check.sh` before pushing.
- New source files must carry the SPDX header:
  `SPDX-License-Identifier: Apache-2.0` / `Copyright 2026 Borek Data Ventures UG`.
- Be respectful — see [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Reporting security issues

Please do **not** open public issues for security vulnerabilities. Email
`contact@datamasterclass.com` with details and we'll coordinate a fix and disclosure.
