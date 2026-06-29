<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Governance — Sovereign Agentic OS

This document describes how the **Sovereign Agentic OS** project is governed: the
roles people hold, how decisions get made, how releases happen, and how someone
becomes a maintainer.

The project is **open-core**. The core is licensed under **Apache-2.0** (see
[`LICENSE`](LICENSE)); a separate commercial Enterprise Edition is stewarded by
**Borek Data Ventures UG (haftungsbeschränkt)** ("the Steward"). This governance
covers the open-source core in this repository.

> **Status:** pre-beta / experimental. Interfaces, chart values, and schema may
> change between pre-releases without notice.

## Roles

### Contributor

Anyone who submits an issue, a pull request, documentation, a review comment, or
other improvement. To get a contribution merged you must:

- Sign the **Contributor License Agreement** ([`CLA.md`](CLA.md)) — once, on your
  first pull request, via the CLA assistant bot.
- Follow [`CONTRIBUTING.md`](CONTRIBUTING.md) and the
  [Code of Conduct](.github/CODE_OF_CONDUCT.md).

Contributors have no standing obligations and may step away at any time.

### Maintainer

Maintainers are the people with write/merge authority and review responsibility.
They are members of the **`@Data-Masterclass/maintainers`** GitHub team, which is
the [`CODEOWNERS`](.github/CODEOWNERS) owner for the repository. Maintainers:

- Triage issues and review pull requests.
- Approve and merge changes (a PR needs **≥ 1 maintainer approval**, a passing
  **CODEOWNERS** review, and **green CI** — see *Decision-making* below).
- Cut releases and manage the publish flow.
- Uphold the Code of Conduct and the project's licensing/SPDX hygiene.
- Mentor contributors and nominate new maintainers.

The Steward (Borek Data Ventures UG) retains final say on licensing, trademark,
security disclosure, and Enterprise Edition matters, and seeds the initial
maintainer set.

## Decision-making

The project runs on **lazy consensus**: proposals proceed unless someone raises a
reasoned objection. Concretely:

- **Ordinary changes** (bug fixes, docs, dependency bumps, additive features):
  a pull request may be merged once it has **at least one maintainer approval**,
  the required **CODEOWNERS** review, and **all required CI checks are green**.
  Repository **admins may self-merge** their own PRs after CI passes (the branch
  ruleset grants admins bypass) so a sole maintainer is never blocked; external
  contributions always go through full review.
- **Significant changes** (architecture, public-API/chart-values/schema breaks,
  new bundled components or their licenses, security-relevant defaults, anything
  affecting the open-core boundary): require **maintainer consensus** — open an
  issue or discussion first, give other maintainers reasonable time (typically a
  few business days) to weigh in, and resolve objections before merging.
- **Disagreements** that lazy consensus can't resolve are decided by the
  maintainers; if maintainers are split, the Steward makes the final call.

All non-trivial discussion happens in the open (issues / pull requests) so the
rationale is recorded.

## Becoming a maintainer

Maintainership is earned through **sustained, high-quality contribution** and good
judgment, not a single big patch. The path:

1. **Contribute consistently** over time — well-scoped PRs, helpful reviews,
   issue triage, and respectful collaboration that follows the Code of Conduct.
2. **Nomination** — an existing maintainer nominates you (typically privately to
   the maintainers, or via an issue) once your track record is clear.
3. **Consensus** — the existing maintainers reach consensus to invite you. With
   no sustained objection, you're invited.
4. **Onboarding** — on acceptance you're added to the `@Data-Masterclass/maintainers`
   team (and thus to `CODEOWNERS` review and merge rights), and you must have
   **signed commits** configured (signed commits are required on `main`).

Maintainers who become inactive for an extended period may be moved to emeritus
status by consensus; they're welcome back when they return to active contribution.

## Release process

The project follows **[Semantic Versioning](https://semver.org/)** (`MAJOR.MINOR.PATCH`).

- **Pre-releases** during the pre-beta phase use the `-alpha.N` (and later
  `-beta.N`) suffix, e.g. `v0.2.0-alpha.2`. The umbrella Helm chart carries its
  own additive SemVer (`charts/sovereign-agentic-os/Chart.yaml: version`) and an
  informational `appVersion` matching the public pre-release.
- The [`CHANGELOG.md`](CHANGELOG.md) follows *Keep a Changelog* and is updated in
  the same PR as the change.

Cutting a release (maintainers):

1. Land all changes for the release on internal `main` with green CI.
2. Update `CHANGELOG.md`, bump `Chart.yaml` `version`/`appVersion` as needed, and
   regenerate docs/SBOM as applicable.
3. **Publish to the public mirror** using the established archive → mirror → push
   flow: `git archive main | tar -x` into the public mirror working tree
   (excluding internal-only `*INTEGRATION.md` notes), run **`gitleaks dir .`** to
   confirm the tree is secret-free, then commit and push the public `main`.
4. Tag and publish the GitHub release: `gh release create vX.Y.Z-pre.N --prerelease`
   (use `--prerelease` for `-alpha`/`-beta`), attaching notes from the changelog.

## Reference documents

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to contribute and the CLA flow.
- [`CLA.md`](CLA.md) — the Contributor License Agreement.
- [`SECURITY.md`](SECURITY.md) — private vulnerability reporting & disclosure.
- [`.github/CODE_OF_CONDUCT.md`](.github/CODE_OF_CONDUCT.md) — community standards.
- [`.github/CODEOWNERS`](.github/CODEOWNERS) — review ownership.
- [`LICENSE`](LICENSE) / [`NOTICE`](NOTICE) / [`TRADEMARKS.md`](TRADEMARKS.md) —
  licensing and marks.
