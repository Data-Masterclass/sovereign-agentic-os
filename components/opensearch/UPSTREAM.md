# OpenSearch

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0
- **Source:** https://github.com/opensearch-project/OpenSearch
- **Pinned as:** Helm chart `opensearch` 3.7.0 (https://opensearch-project.github.io/helm-charts)

**Why the OS ships it:** User directory (`os-users`) and every `os-*` search/derived index.

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/`); any glue we wrote belongs there or in the
owning tab, never here.
