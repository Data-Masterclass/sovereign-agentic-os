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

## Running the checks

```bash
node scripts/check-structure.mjs    # structure + file headers (a ratchet — see below)
npm --prefix os-ui test             # the unit suite
bash os-ui/scripts/gate.sh          # the regression gate
helm lint charts/sovereign-agentic-os -f values.local.yaml
```

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
- **Merge with "Rebase and merge", never squash.** A squash creates a commit absent from the
  branch's ancestry, so the next branch reports conflicts in every touched file.

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
