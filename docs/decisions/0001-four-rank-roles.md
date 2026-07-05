<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# ADR 0001 — Four-rank role model

**Status:** Accepted (shipped in os-ui 0.1.32) · **Source:** `os-ui/lib/session.ts`, `os-ui/lib/governance/roles.ts`

## Context

The 3-rank model (`creator < builder < admin`) forced a bad trade-off: to let a
domain lead manage their own team's accounts we either had to hand them tenant
`admin` (over-privilege) or make Builders people-admins (conflating "approves
artifacts" with "manages people"). Real tenants — e.g. the cohort domain — need
a per-domain people-admin who still cannot touch tenant structure.

## Decision

Insert one rank: `creator (0) < builder (1) < domain_admin (2) < admin (3)`.
A **domain_admin** is a Builder **plus** (a) user administration scoped to their
own domain(s) only — invite/edit/deactivate, assign roles **up to builder**,
never lateral or upward — and (b) all domain-scoped governance approvals. Only
the platform **admin** appoints domain_admins. All floor gates compare by rank
(`roleAtLeast`), so domain_admin inherits every Builder surface automatically.
Legacy/unknown roles normalise to `creator`; nobody is auto-promoted on upgrade.

## Consequences

- Builders stay pure approvers, not people-admins (user admin moved up a rank).
- The Platform group, marketplace certification, cost caps, pillars, and the
  role matrix remain platform-admin-only; the last-active-admin lockout guard
  is unchanged.
- Enforced server-side per call (`canAdministerUsers`, `userAdminInScope`,
  `canTouchUser`), every mutation audited — the UI is presentation only.
