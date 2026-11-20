# kind

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0
- **Source:** https://github.com/kubernetes-sigs/kind
- **Pinned as:** kind `v0.32.0`, node image
  `kindest/node:v1.35.5@sha256:ce977ae6d65918d0b58a5f8b5e940429c2ce42fa3a5619ec2bbc60b949c0ac95`
  (from the v0.32.0 release notes).
- **Docs:** https://kind.sigs.k8s.io/docs/user/configuration/

**Why the OS uses it:** test infrastructure only — the cluster of the acceptance harness
(`tests/e2e/kind/`) and of the laptop profile (`scripts/os`). The pin lives in `tests/e2e/kind/versions.env`.
