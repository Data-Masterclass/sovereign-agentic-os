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
