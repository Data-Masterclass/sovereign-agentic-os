# Calico

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0
- **Source:** https://github.com/projectcalico/calico
- **Pinned as:** manifest `https://raw.githubusercontent.com/projectcalico/calico/v3.32.3/manifests/calico.yaml`,
  sha256 `3db4c55514b678be853be49b8cb102bed0a00bc0343eec05ac191652dc7211e0` (images `quay.io/calico/{node,cni,kube-controllers}:v3.32.3`).
  Released 2026-10-28; v3.33.1 (2026-11-16) was too new to pin.
- **Docs:** https://docs.tigera.io/calico/latest/getting-started/kubernetes/kind

**Why the OS uses it:** test infrastructure only. The kind acceptance harness
(`tests/e2e/kind/`) disables kind's default CNI, which does not enforce NetworkPolicies, and installs
Calico so the chart's NetworkPolicies are enforced as they are on STACKIT. Not part of the chart.
The pin lives in `tests/e2e/kind/versions.env`; `up.sh` verifies the manifest's sha256 before applying it.
