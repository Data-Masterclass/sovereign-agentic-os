# MinIO

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** AGPL-3.0-or-later
- **Source:** https://github.com/minio/minio
- **Pinned as:** Image `ghcr.io/aborek/sovereign-os/minio@sha256:1887982b34cc821a569fdc94c4d30ee01c2826184fe7d3a49aee37bb3bbb23a7` — our ghcr mirror of the upstream release, built unmodified; upstream withdrew the docker.io/quay.io tags we pinned.

**Why the OS ships it:** Object storage: Files, lakehouse objects, backups. **AGPL**: offering the OS as a managed service means offering MinIO's source to its users — we ship it unmodified, so the upstream repository satisfies that.

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/`); any glue we wrote belongs there or in the
owning tab, never here.
