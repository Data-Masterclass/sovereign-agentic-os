# Written offer for corresponding source — copyleft components

The Sovereign Agentic OS bundles one copyleft-licensed component as a **separate,
unmodified program** (mere aggregation — it is not linked into or derived from
Borek Data Ventures UG's own Apache-2.0 code). This file records the exact upstream
source so the "corresponding source" is locatable, and constitutes a written offer
to provide that source for the air-gapped image bundle.

We redistribute it **unmodified** (the distribution package in our pinned images).
We make no changes to its source. Its corresponding source is the upstream
release identified below.

---

## git — GPL-2.0-only (separate program)

- Component: git (backup-tools, git-daemon and git-http images; `git bundle`/`fsck`, `git daemon`, `git-http-backend`)
- License: GPL-2.0-only (full text: `licenses/GPL-2.0.txt`)
- Distributed version: **2.47.3**, the unmodified Alpine package
- Upstream source repository: https://git.kernel.org/pub/scm/git/git.git (tag `v2.47.3`)
- Source tarball (corresponding source): https://mirrors.edge.kernel.org/pub/software/scm/git/git-2.47.3.tar.xz

git runs as its own process, invoked by the chart's jobs and containers; it is not linked into any Data Masterclass
code. The reviewed exception for it (condition `separate-program`) is in `licenses/exceptions.json`.

---

## Air-gapped image bundle

Per `stackit/packaging.md`, the air-gap bundle ships the SBOM (`sbom.cdx.json`),
`THIRD-PARTY-LICENSES.md`, and this `licenses/` directory alongside the mirrored
container images. For the copyleft components above, the bundle build SHOULD also
mirror the corresponding **source** tarballs (at the commits recorded here) next to
the images, or rely on this written offer, which is valid for any third party who
received the bundle: Borek Data Ventures UG will, on request, provide a copy of the
corresponding source for the exact versions shipped, for a charge no more than the
cost of physically performing the distribution.

Contact: alex@datamasterclass.com
