<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Security Policy — Sovereign Agentic OS

We take the security of **Sovereign Agentic OS** seriously. Thank you for helping
keep the project and its users safe.

> **Status:** this is **pre-beta / experimental** software. Do not run it with
> production secrets or sensitive data without your own hardening review.

## Supported versions

During the pre-beta phase we provide security fixes only for the **latest
published pre-release** on the default branch. Older `-alpha`/`-beta`
pre-releases are **not** maintained — please upgrade to the latest before
reporting.

| Version                         | Supported          |
| ------------------------------- | ------------------ |
| Latest `0.x` pre-release (`main`) | :white_check_mark: |
| Any older pre-release           | :x:                |

Once the project reaches a stable `1.x`, this table will be updated with a
concrete support window.

## Reporting a vulnerability

**Please do not open public issues, pull requests, or discussions for security
vulnerabilities.** Public disclosure before a fix is available puts users at risk.

Report privately through either channel:

1. **GitHub Security Advisories (preferred)** — use
   **[Report a vulnerability](https://github.com/Data-Masterclass/sovereign-agentic-os/security/advisories/new)**.
   This opens a private advisory visible only to you and the maintainers and lets
   us collaborate on a fix and a coordinated release.
2. **Email** — `security@datamasterclass.com`. Encrypt if you can; otherwise send
   a brief, non-sensitive first message and we'll arrange a secure channel.

Please include, as far as you can:

- A description of the issue and its impact.
- Affected version / commit, component or chart, and deployment target.
- Steps to reproduce or a proof of concept.
- Any suggested remediation.

**Do not** include real secrets, customer data, or live credentials in a report —
redact them.

## Our commitment & response targets

We aim to (best-effort during pre-beta):

- **Acknowledge** your report within **3 business days**.
- Provide an **initial assessment** (severity, whether confirmed) within **10
  business days**.
- Keep you updated on remediation progress and agree on a disclosure timeline.

## Coordinated disclosure

We follow **coordinated disclosure**:

- We'll work on a fix privately, validate it, and prepare a release.
- We ask that you give us a reasonable window — typically up to **90 days** from
  acknowledgement — before any public disclosure, and that you don't exploit or
  share the issue in the meantime. We'll move faster for actively exploited or
  high-severity issues.
- When a fix ships we'll publish a **GitHub Security Advisory** (and a CVE where
  applicable) and **credit you** for the report unless you prefer to remain
  anonymous.

We will not pursue legal action against good-faith security research that follows
this policy. There is no paid bug-bounty program at this stage.

## Scope notes

- **Secrets are external** to this repository by design (see `README.md` →
  Conventions). Reporting that a committed example value is a placeholder is not a
  vulnerability — but if you find a *real* leaked secret, report it privately and
  urgently.
- Vulnerabilities in **bundled third-party components** (see
  `THIRD-PARTY-LICENSES.md`) should also be reported to their upstream projects;
  tell us so we can update or mitigate.
