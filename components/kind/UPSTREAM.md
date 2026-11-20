# kind

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0
- **Source:** https://github.com/kubernetes-sigs/kind
- **Pinned as:** kind `v0.32.0`, node image
  `kindest/node:v1.36.1@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5`
  (the v0.32.0 default, from its release notes).
- **Docs:** https://kind.sigs.k8s.io/docs/user/configuration/

**Why the OS uses it:** test infrastructure only — the cluster of the acceptance harness
(`tests/e2e/kind/`) and of the laptop profile (`scripts/os`). The pin lives in `tests/e2e/kind/versions.env`.
