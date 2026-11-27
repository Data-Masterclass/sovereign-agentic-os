# PostgreSQL (CloudNativePG)

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** PostgreSQL License (server) · Apache-2.0 (CloudNativePG operator)
- **Source:** https://github.com/cloudnative-pg/cloudnative-pg
- **Pinned as:** Image `ghcr.io/cloudnative-pg/postgresql:17.5@sha256:b1deeed2aa998b2f381e39c5cadb9ec06127708c8bd62965743af19abf21628f` (CNPG) · fallback `postgres:17@sha256:5c855ad7b85e68e48a62f34662853f38b57c1c1d80f3a927ab58034fd6d31c5e`

- **Operator (App Builder app databases, workstream D):** CloudNativePG `1.30.2`, release manifest
  `https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.30/releases/cnpg-1.30.2.yaml`
  (sha256 `ea4cc355b394e10661d30c6b409cefb19029dd973bccb76b1ed8c789985bc68c`), image
  `ghcr.io/cloudnative-pg/cloudnative-pg:1.30.2@sha256:f96f6be3d81ec93819b443c665c575c609342fca840df90d4d87dae314a5b913`
  (label `org.opencontainers.image.licenses=Apache-2.0`). Installed by `scripts/cnpg/install.sh`; pins in
  `scripts/cnpg/versions.env`. The app databases' operand image is an owner decision (licence):
  `docs/components/app-databases.md`.

**Why the OS ships it:** Control-plane state, Langfuse, LiteLLM, Dagster and the lakehouse catalog; with the App
Builder, one database per app (`apps-pg` per env namespace).

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/`); any glue we wrote belongs there or in the
owning tab, never here.
