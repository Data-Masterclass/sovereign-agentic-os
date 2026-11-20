# OpenSearch

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0 (core and the bundled plugins, including `repository-s3`, ISM and Snapshot Management)
- **Source:** https://github.com/opensearch-project/OpenSearch
- **Pinned as:** Helm chart `opensearch` 3.7.0 (https://opensearch-project.github.io/helm-charts)
- **Image:** `opensearchproject/opensearch:3.7.0@sha256:44ba7ea58a319adf61c33ab16873f9ef5dbb30b291a832d375172f0b2d24e3c9`
  (multi-arch index), extended in `images/extensions/opensearch/Dockerfile` with the official
  `repository-s3` plugin for the same core version. The upgrade to 3.10.0 is WP-23.
- **Docs used (version-pinned to 3.7):**
  - Snapshots, `repository-s3`, keystore keys, `s3.client.default.*` settings, `_verify`:
    https://docs.opensearch.org/3.7/tuning-your-cluster/availability-and-recovery/snapshots/snapshot-restore/
  - Snapshot Management API (`_plugins/_sm/policies`, `_explain`):
    https://docs.opensearch.org/3.7/tuning-your-cluster/availability-and-recovery/snapshots/sm-api/
  - Data streams (`DELETE _data_stream/<name>` removes the backing `.ds-*` indices):
    https://docs.opensearch.org/3.7/im-plugin/data-streams/
  - Helm chart `keystore` (secret keys become keystore entries):
    https://github.com/opensearch-project/helm-charts/tree/opensearch-3.7.0/charts/opensearch
- **Test stand-ins (CI only):** SeaweedFS `chrislusf/seaweedfs:4.52@sha256:57877e32bb90073b37dc109b438ba66e84fd5ed9ced5f5c04f56444ef243ce59`
  (Apache-2.0) as the S3 store; the chart's own egress proxy image (`images/base/egress-proxy`)
  as the proxy.

**Why the OS ships it:** User directory (`os-users`) and every `os-*` search/derived index.

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/`); any glue we wrote belongs there or in the
owning tab, never here.
