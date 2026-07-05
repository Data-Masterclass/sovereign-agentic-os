<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# ADR 0002 — The sharing ladder (trigger ≠ approve, two rungs)

**Status:** Accepted (canonical semantics; datasets/files live, remaining kinds being re-wired) · **Source:** `os-ui/lib/mcp/write-tools.ts` (`request_promotion`/`approve_promotion`), `os-ui/lib/governance/roles.ts` (`canPromote`), mcp-v2 design

## Context

Visibility widens Personal → Domain → Marketplace. Early builds were
inconsistent: some artifact kinds promoted in one step by whoever held the role
(builder-direct `publish`, admin-initiated certification), which collapses the
separation of duties and lets an approver promote work its owner never asked
to share.

## Decision

Two rungs, each strictly **trigger → approve** — the parties never collapse
into one caller:

1. **Promotion (Personal → Domain):** triggered by **the owner of the
   artifact, and only the owner** (owner-checked; edit rights are not enough);
   approved by a **builder+ of that domain** (domain_admin and admin qualify by
   rank). Docs + ≥1 tag are the gate before filing.
2. **Certification (Domain → Marketplace):** triggered by a **builder or
   domain_admin in the artifact's domain** — the domain vouches for it;
   approved by a **platform admin** — the platform accepts it. Admins do not
   self-initiate certification of domain artifacts.

Approving **is** the action: on approve the platform executes the governed
effect (physical publish for datasets) and writes the audit; a failed
materialization leaves the request pending — the tier never flips on a failure.

## Consequences

- One enforcement seam (stores + approvals layer) serves both the UI and MCP.
- Legacy one-step paths (knowledge publish, connection promote, model
  certify) are being migrated onto the ladder — until then they are the
  documented exception, not the model.
