# External Secrets Operator

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0 (`gh api repos/external-secrets/external-secrets/license --jq .license.spdx_id` → `Apache-2.0`, 20 Nov 2026)
- **Source:** https://github.com/external-secrets/external-secrets
- **Pinned as:** Helm chart `external-secrets/external-secrets` **2.15.0** from https://charts.external-secrets.io
  (`helm pull` tgz sha256 `ed94d41cc67e392ea45e370345eb491b0fdc21387f1aaaefcf8e2e6c85089e1d`), app/image
  `ghcr.io/external-secrets/external-secrets:v2.15.0@sha256:6888f243e5f8f7592c6d7fae2a5547c9e33531441b47b53807b9093b25a00e31`
  (released 10 Nov 2026). Installed as its OWN Helm release in namespace `external-secrets`, before the
  platform chart: `deploy/external-secrets/install.sh`. CRDs come from that chart (`installCRDs: true`).
- **API used:** `external-secrets.io/v1` `ClusterSecretStore` and `ExternalSecret` (the only served
  version on 2.15.0; `v1beta1` is no longer served). `PushSecret` is `v1alpha1` and is not used yet.
- **Docs used (fetched 20 Nov 2026):**
  - Vault provider, KV v2, `userPass` auth (`path`, `username`, `secretRef`): https://external-secrets.io/latest/provider/hashicorp-vault/
  - `ExternalSecret` (`target.creationPolicy`, `target.template.type`, `data[].remoteRef.property`): https://external-secrets.io/latest/api/externalsecret/
  - Lifecycle / creation policies (`Orphan`: the Secret is written and updated but carries no owner reference): https://external-secrets.io/latest/guides/ownership-deletion-policy/
  - Fake provider (CI only): https://external-secrets.io/latest/provider/fake/
- **Backend: STACKIT Secrets Manager** (managed service, not shipped). HashiCorp-Vault KV v2 compatible
  with `userpass` auth; base URL `https://prod.sm.eu01.stackit.cloud`; the KV mount is the instance ID;
  secret path `<instance-id>/data/<name>`; userpass tokens last 15 min (renewable to 24 h).
  - https://docs.stackit.cloud/products/security/secrets-manager/how-tos/cli-and-api/
  - https://docs.stackit.cloud/products/security/secrets-manager/getting-started/configure-the-secrets-manager/
  - https://docs.stackit.cloud/products/security/secrets-manager/how-tos/configure-access-control-lists/
  - https://docs.stackit.cloud/products/security/secrets-manager/how-tos/session-and-token-handling/
  - CLI: `stackit secrets-manager instance create --name … --acl <cidr>`, `stackit secrets-manager user create --instance-id … [--write]` (stackit-cli `--help`).

**Why the OS ships it:** design 00 §3.2 / S2 (MASTER-PLAN WP-10) — every platform credential is a
Kubernetes Secret that External Secrets writes from STACKIT Secrets Manager, so no credential value
lives in the chart, a values overlay or a process. The glue (the `ClusterSecretStore`, one
`ExternalSecret` per platform Secret with the SAME name, type and keys) is in
`charts/sovereign-agentic-os/templates/base/external-secrets/`; the Secret catalog is
`charts/sovereign-agentic-os/files/external-secrets/catalog.yaml`. Proof against the real operator:
`scripts/tests/external-secrets.kind.sh`.
