# Apache Polaris (incubating)

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0
- **Source:** https://github.com/apache/polaris
- **Pinned as:** Image `apache/polaris:1.1.0-incubating@sha256:27d081a539aa021df00f18ff1ae0a59d9b9e7a1db2a44b643ba29c61eaa9cdf9` · admin tool `apache/polaris-admin-tool:1.1.0-incubating@sha256:7cdd9216c2e55a45ad0e725f47949c7632e6eadcf1e18bbcaeee19ea65f2c94e`

**Why the OS ships it:** Iceberg REST catalog behind Trino and the Data tab.

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/`); any glue we wrote belongs there or in the
owning tab, never here.

## Evaluation at WP-13: the Polaris OPA authorizer (design 06 §5.6, §8 #5)

Read on 2026-11-20 from https://polaris.apache.org/releases/1.9.0/managing-security/external-pdp/opa
(1.9.0 is the newest release, https://github.com/apache/polaris/releases) and the 1.3.0 page. From
upstream docs only; not run.

- **Status:** "OPA integration is currently a preview feature" that "may undergo breaking changes
  in future versions", unchanged from 1.3.0 to 1.9.0.
- **Config:** `polaris.authorization.type=opa` (default `internal`), `polaris.authorization.opa.policy-uri`,
  `…opa.http.timeout` (default `PT2S`), `…opa.http.verify-ssl`, trust store, and
  `…opa.auth.type=none|bearer` with a static or file-based (refreshed) bearer token.
- **Input:** `actor` (principal, roles, attributes), `action` (a `PolarisAuthorizableOperation`
  such as `LOAD_TABLE_WITH_READ_DELEGATION`), `resource` (targets and secondaries, with parents),
  `context.request_id`.
- **Scope:** the authorizer type is one or the other. Grant and policy management stays in
  Polaris's own model, and the page asks policies to deny internal operations such as
  `CREATE_POLICY`. Behaviour when OPA is unreachable is not documented.

**Decision (WP-13): not adopted now.** Keep Polaris's internal RBAC, with per-namespace grants
from the namespace reconciler (06 T6). Reasons:
1. It is preview, with breaking changes announced.
2. It needs Polaris ≥ 1.3; the pin is 1.1.0.
3. Its fail-closed behaviour on an OPA outage is undocumented.

Re-evaluate when the feature leaves preview. The input shape maps cleanly onto a
`package polaris` beside `package trino` in the same OPA, so the direction in 06 §5.6 stays the
target.

**Upgrade (06 T0): not done in WP-13.** 1.1.0 → 1.9.0 spans eight releases, and the release
notes read here name no schema-migration step. The JDBC metastore must still be backed up
(Velero) before any bump, and the bump needs its own harness run
(`bash tests/lakehouse/up.sh --set polaris.image.tag=… --set polaris.adminImage.repository=apache/polaris-admin`).
From 1.9.0 the admin image is `apache/polaris-admin`, not `apache/polaris-admin-tool`.
