<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
## Summary

<!-- What does this PR change, and **why**? Link any related issue (e.g. `Closes #123`). -->

## Type of change

<!-- Check all that apply. -->

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking, additive)
- [ ] Breaking change (public API / chart values / schema / defaults)
- [ ] Documentation only
- [ ] Chart / deployment / packaging
- [ ] CI / tooling
- [ ] Other (describe):

## Checklist

- [ ] I have signed the **Contributor License Agreement** ([`CLA.md`](../CLA.md)) (the CLA bot will prompt on first PR).
- [ ] My commits are **signed** (`git commit -S`) — signed commits are **required** on `main`.
- [ ] Relevant checks pass locally: `npm --prefix os-ui run build`, `helm lint charts/sovereign-agentic-os`, and any tests.
- [ ] I updated **documentation** for any user-facing change.
- [ ] I updated [`CHANGELOG.md`](../CHANGELOG.md) under the unreleased / current pre-release section.
- [ ] **No secrets** are committed (real credentials, tokens, kubeconfigs, `.env` values stay external).
- [ ] New/modified source files carry the **SPDX + copyright header** (`scripts/add-spdx-headers.sh`); no new dependency license falls outside `licenses/allowed-licenses.txt`.
- [ ] For breaking changes: I called it out above and (for significant changes) discussed it with maintainers first.

## Notes for reviewers

<!-- Anything that helps review: test plan, screenshots, deployment target tested (kind / STACKIT / ...), risks. -->
