<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# ADR 0006 — Analytics-monorepo git identity model

Date: 2026-07-20 · Status: **ACCEPTED**

## Decision
**Option B — per-user, server-minted, short-lived, domain-scoped Forgejo tokens**,
with a scoped **non-admin machine account** for automation (seed, mirror, modelSync,
Dagster clone, CI checkout). Chosen by the platform owner (aborek) on 2026-07-20.

## Why
Real git attribution, real Forgejo branch-protection + PR review mapped to the OS
promotion ladder (builder+ can approve on `main` for OS-managed paths), and least-
privilege tokens revocable centrally on deactivation. This makes "reviewed, versioned
analytics code" literally true at the git layer rather than simulated above it, and is
the direction already set by `developer-mode-cli.md` + `docs/ROADMAP.md`.

## Consequences
- Phases 0–1 of `docs/research/analytics-monorepo-plan.md` are identical under either
  option and proceed now. **Phase 2** builds the token-mint route + Forgejo user
  provisioning + `sos git` credential helper + branch protection.
- The shared Forgejo admin SA shrinks to bootstrap-only; five machine consumers migrate
  to the scoped `analytics-bot` account.
- Secrets stay write-only (never logged/committed); tokens are short-TTL, minted server-side.
