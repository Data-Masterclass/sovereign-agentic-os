# Contributing to the Sovereign Agentic OS

Thanks for your interest in contributing! The core is **Apache-2.0** (see `LICENSE`).
Bundled third-party components keep their own licenses (see `THIRD-PARTY-LICENSES.md`);
please don't add a dependency whose license the policy forbids — CI enforces it
(`.github/workflows/license-gate.yml`, `scripts/license-gate.mjs`).

**Licence policy (owner decision, 2026-11-22), for the whole repo — code, images, chart components, app templates:**
allowed are Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Zlib, Unlicense, BlueOak-1.0.0,
PSF-2.0/Python-2.0, and CC-BY-4.0 / CC0-1.0 for data and docs. Forbidden are all copyleft (GPL, LGPL, AGPL, MPL,
EPL, CDDL, EUPL) and all source-available licences (BUSL/BSL, SSPL, Elastic-2.0, Commons Clause, CC-BY-NC-*,
CC-BY-SA-*). An unknown or missing licence fails unless `licenses/exceptions.json` has a reviewed entry with a
reason. A dual-licensed package passes if one option is allowed. Anything other than Apache-2.0/MIT needs an
attribution entry (`THIRD-PARTY-LICENSES.md` or `licenses/ATTRIBUTIONS.md`). The single source is
`licenses/policy.json`.

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
`THIRD-PARTY-LICENSES.md`, the license text in `licenses/`, and a regenerated `sbom.cdx.json`. The licence must be
allowed by `licenses/policy.json`; a copyleft or source-available component is not added.
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
node scripts/check-glue.mjs         # glue-discipline rules GLUE-1 … GLUE-10 (a ratchet — see below)
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

**`@sovereign-os/*` never comes from a registry.** The project does not own that scope on the
public npm registry, so a scaffold may only declare those packages as `file:` dependencies on the
vendored folder, and every template tree carries the `.npmrc` from
`os-ui/tabs/software/lib/scope-pin.ts`, which points the scope at a host that cannot resolve. Do
not remove that file, do not add a version range, URL or git reference for the scope, and do not
write `npm install @sovereign-os/...` into a Dockerfile or script; the deploy scan blocks a tree
that would fetch the scope. See "The `@sovereign-os` scope is pinned to nowhere" in
`os-ui/ARCHITECTURE.md`.

`check-structure.mjs` is a **ratchet**: pre-existing violations are baselined in
`scripts/structure-baseline.json` and the counts may only go **down**. Pay one down, then run
it with `--baseline` to lock the new number in. It also requires a
`FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header on every source file, alongside the SPDX
header described under Pull requests.

`check-glue.mjs` enforces the glue-discipline rules of design 00 §8.3 and the artifact contract
(C2, component-design 11 §4.1): only `os-ui/core/adapters/**` talks to a component; admin
credentials stay in admin adapters; no silent fallback; no hard-coded version; no re-coded
component feature; every native-config generator is registered in `scripts/glue/generators.json`
with golden fixtures that the component's own tool validates (`scripts/validate-generated.sh`);
every mutating route and MCP tool calls governance `authorize()`; no `setInterval` outside the
reconciler runtime; the kernel never imports a tab and a tab never imports another; and generated
native code carries OS metadata only in the tool's documented extension points. The rules read the
TypeScript AST (and dependency-cruiser, ajv with the tools' JSON schemas, Python's `ast`), not a grep.

Its ratchet is **by fingerprint**, not by count: `scripts/structure-baseline.json` → `glue` lists
each known finding (`<file> :: <normalised snippet>`), and any finding not listed fails — fixing an
old one never makes room for a new one. Fix a finding, then run `node scripts/check-glue.mjs
--baseline` to drop it. The baseline may only shrink: CI's guard (`--guard <base>`) fails any change
that adds a fingerprint unless the same change sets a new `glue.$approvedRaise` text, which the owner
sees in the diff. `--list <RULE>` prints every finding of one rule. Each rule has negative twins in
`scripts/tests/glue-fixtures/<RULE>[--<variant>]/`, and the cases an independent review used to evade
the rules are kept in `scripts/tests/check-glue-evasions.test.mjs`:
`node --test scripts/tests/check-glue.test.mjs scripts/tests/check-glue-evasions.test.mjs`.

**Before writing code, read [`os-ui/ARCHITECTURE.md`](os-ui/ARCHITECTURE.md)**, especially
"Things this codebase will punish you for". It records constraints that have each cost real
debugging time — a Next.js `route.ts` may export only its handlers, a test cannot import a
`.tsx`, and a fallback must never report success with substituted data.

## Operating this repo

- Local: `./scripts/os up | test | down`. A cluster: `./scripts/deploy.sh <version>`, which
  backs up first and aborts if the backup gate fails.
- **Release with `./scripts/release.sh <version>`** (`--dry-run` first). It refuses unless CI
  passed on a push to `main` for that exact commit, tags it, waits for the image build (which
  refuses a commit without green CI too), deploys and runs `./scripts/smoke-test.sh`. The steps,
  what to do when it stops, and how to roll back: [`docs/ops/releasing.md`](docs/ops/releasing.md).
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
on a `os-ui-v*` / `git-http-v*` / `dagster-v*` / `docling-v*` / `data-runner-v*` tag, or by hand via **Run workflow** (inputs:
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

**The decision is taken (2026-11-19): option A, for `os-ui` only.** The os-ui image lives at
`ghcr.io/data-masterclass/sovereign-os/os-ui`. This repository is `Data-Masterclass/…`, so the
workflow's built-in `GITHUB_TOKEN` pushes there with no secret and no variable — it **cannot**
push to the `aborek` user namespace, which is why the image moved rather than the workflow.
Production was switched the same day (`--from-registry 0.9.6`, Helm revision 415). What that
took, and what it did not:

- **No pull-secret change.** A `kubernetes.io/dockerconfigjson` secret is
  keyed by registry **host** (`ghcr.io`), so the existing credential already addresses the new
  namespace.
- **No visibility change.** `GITHUB_TOKEN` creates the package **private and scoped to this
  repository**, and it stays private: the account behind the cluster's `ghcr.io` credential
  (`aborek`) is an admin of this repository and can already read it.
- **Only os-ui moved.** `git-http`, `git-daemon`, `dagster`, `minio` and every other image are
  still at `ghcr.io/aborek/sovereign-os/*`. So **one credential reads both namespaces**, and
  must keep doing so: revoke that account's access to this repository and os-ui stops pulling;
  rotate its token and everything does.

```bash
git tag os-ui-v<version> && git push public os-ui-v<version>   # CI builds, smokes, pushes
./scripts/deploy.sh --from-registry <version>
```

`IMAGE_REPO` defaults to `ghcr.io/data-masterclass/sovereign-os` and names the **os-ui**
repository only — `deploy.sh` carries every other image's repository over from the live
release untouched. Passing it (any value, the default included) also `--set`s the chart's
`osUI.image.repository`; leaving it unset keeps the release's own repository and runs the
mismatch refusal above.

**A local build is still there, but it is no longer the supported path.** A plain
`./scripts/deploy.sh <version>` builds on the laptop and `docker push`es to `IMAGE_REPO` with
your own `docker login ghcr.io`. With the new default that is the org package, so one of:

- **push rights on the org package** — a token with `write:packages` from an account that has
  write access to `data-masterclass/sovereign-os/os-ui`. Without it the run ends in
  `PUSH_FAILED`: after the backup gate, before any `helm upgrade`, so the cluster is unchanged.
- **`IMAGE_REPO=ghcr.io/aborek/sovereign-os ./scripts/deploy.sh <version>`** — pushes to the old
  namespace, where laptop credentials have always worked. Because `IMAGE_REPO` was passed, this
  also moves the release's `osUI.image.repository` **back** to `aborek`. The next plain
  `--from-registry` deploy is then refused (`IMAGE_REPOSITORY_MISMATCH`: the release pulls from
  `aborek`, the CI image is in `data-masterclass`) until it is run once with
  `IMAGE_REPO=ghcr.io/data-masterclass/sovereign-os`.

**Option B — the alternative not taken: keep CI pushing to `ghcr.io/aborek/sovereign-os`.**
Needs a classic PAT with `write:packages` on the `aborek` account as the repository secret
`GHCR_TOKEN`, plus two repository variables. `IMAGE_REGISTRY_USER` matters — the registry login
user must be the **PAT's owner**, and the workflow otherwise uses `github.actor`, i.e. whoever
pushed the tag. Deploys then need `IMAGE_REPO=ghcr.io/aborek/sovereign-os` every time.

```bash
gh variable set IMAGE_REPO_PREFIX   --repo Data-Masterclass/sovereign-agentic-os --body ghcr.io/aborek/sovereign-os
gh variable set IMAGE_REGISTRY_USER --repo Data-Masterclass/sovereign-agentic-os --body aborek
gh secret   set GHCR_TOKEN          --repo Data-Masterclass/sovereign-agentic-os   # paste the PAT
```

## Pull requests

- Keep changes small and focused; explain **what** and **why**.
- **Never commit secrets** — secrets are external (see `README.md` → Conventions). Real
  credentials, tokens, kubeconfigs, or `.env` values must never be committed.
- Match the existing style; pin upstream chart versions and image digests.
- If you added source files or touched dependencies, run `scripts/add-spdx-headers.sh` and
  `scripts/license-check.sh` before pushing (after a dependency change also
  `node scripts/license-gate.mjs --python-resolve --write-attributions`).
- New source files must carry the SPDX header:
  `SPDX-License-Identifier: Apache-2.0` / `Copyright 2026 Borek Data Ventures UG`.
- Be respectful — see [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Reporting security issues

Please do **not** open public issues for security vulnerabilities. Email
`contact@datamasterclass.com` with details and we'll coordinate a fix and disclosure.
