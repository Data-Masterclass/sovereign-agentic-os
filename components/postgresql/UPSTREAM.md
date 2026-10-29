# PostgreSQL (CloudNativePG)

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** PostgreSQL License (server) · Apache-2.0 (CloudNativePG operator)
- **Source:** https://github.com/cloudnative-pg/cloudnative-pg
- **Pinned as:** Image `ghcr.io/cloudnative-pg/postgresql:17.5@sha256:b1deeed2aa998b2f381e39c5cadb9ec06127708c8bd62965743af19abf21628f` (CNPG) · fallback `postgres:17@sha256:5c855ad7b85e68e48a62f34662853f38b57c1c1d80f3a927ab58034fd6d31c5e`

**Why the OS ships it:** Control-plane state, Langfuse, LiteLLM, Dagster and the lakehouse catalog.

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/`); any glue we wrote belongs there or in the
owning tab, never here.
