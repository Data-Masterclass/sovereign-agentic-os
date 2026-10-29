# Apache Polaris (incubating)

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0
- **Source:** https://github.com/apache/polaris
- **Pinned as:** Image `apache/polaris:1.1.0-incubating@sha256:27d081a539aa021df00f18ff1ae0a59d9b9e7a1db2a44b643ba29c61eaa9cdf9` · admin tool `apache/polaris-admin-tool:1.1.0-incubating@sha256:7cdd9216c2e55a45ad0e725f47949c7632e6eadcf1e18bbcaeee19ea65f2c94e`

**Why the OS ships it:** Iceberg REST catalog behind Trino and the Data tab.

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/`); any glue we wrote belongs there or in the
owning tab, never here.
