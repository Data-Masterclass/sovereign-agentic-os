# Enterprise Edition (`ee/`) — placeholder

This directory is reserved for the **Sovereign Agentic OS Enterprise Edition (EE)**.

**There is no proprietary code here yet.** This is an intentional placeholder marking
where commercial, license-gated modules will live if/when they ship.

## Model (the Langfuse pattern)

- The **core platform is and stays free & open source under Apache-2.0** — including the
  full OS UI. The free core is genuinely complete and production-usable on its own; EE is
  **scale / compliance / support add-ons**, never a gate on basic sovereignty.
  (See `stackit/delivery-models.md` → "Editions & openness model".)
- EE modules, when they land, will live **only** under `ee/` and be licensed under a
  **separate commercial license** — **`ee/LICENSE` (NOT Apache-2.0)** — and gated behind a
  **license key**. They are not covered by the repository's root `LICENSE`.
- Candidate EE features (TBD): enterprise SSO/SCIM, advanced audit/compliance reporting,
  fleet / multi-cluster management, premium support/SLA, advanced policy packs.

## Rules

- **Nothing under `ee/` is Apache-2.0.** Do not add an open-source `LICENSE` here; the
  root Apache-2.0 license does not extend into this directory.
- No EE/proprietary source is committed until the commercial license and license-key
  gating are in place. Until then this file is the only content.
- Community contributions are accepted into the Apache-2.0 **core** under the DCO (see
  `CONTRIBUTING.md`), **not** into `ee/`.

_Not legal advice — the commercial license + key mechanism will be set up with counsel
before any EE code ships._
