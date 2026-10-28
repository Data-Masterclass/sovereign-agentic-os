# Dagster

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0
- **Source:** https://github.com/dagster-io/dagster
- **Pinned as:** Helm chart `dagster` 1.13.11 (https://dagster-io.github.io/helm)

**Why the OS ships it:** Scheduled syncs and pipelines: SQL sources, OneDrive/Google Drive, dbt models, re-indexing.

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/`); any glue we wrote belongs there or in the
owning tab, never here.
