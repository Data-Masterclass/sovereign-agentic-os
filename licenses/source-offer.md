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

## litellm-oss image — psycopg (LGPL-3.0-only) and certifi / orjson / tqdm (MPL-2.0)

Shipped **unmodified** under a reviewed, written owner exception, signed off 2026-11-24, scoped to the
LiteLLM gateway image `ghcr.io/data-masterclass/sovereign-os/litellm-oss` only
(`licenses/exceptions.images.json`). They are separate Python packages, dynamically imported, not linked
into or derived from our code, and replaceable. How to replace psycopg is in the image's
`/usr/share/licenses/litellm-oss/THIRD_PARTY_NOTICES.md` (source: `images/extensions/litellm-oss/THIRD_PARTY_NOTICES.md`).
The full licence texts ship in the image under `/usr/share/licenses/litellm-oss/` (each package's own
files plus `texts/GPL-3.0.txt` and `texts/MPL-2.0.txt`).

| Package | Version | Licence | Corresponding source (PyPI sdist, sha256) |
|---|---|---|---|
| psycopg | 3.3.6 | LGPL-3.0-only | https://pypi.org/project/psycopg/3.3.6/ — `psycopg-3.3.6.tar.gz`, `c081f2250df751a943036e42db6df4571c66cd0aabe8291a7a506512b12007d2`; upstream https://github.com/psycopg/psycopg tag `3.3.6` |
| certifi | 2026.10.19 | MPL-2.0 | https://pypi.org/project/certifi/2026.10.19/ — `035c1e85572b141bf1c3a3eff0e33a8eb74917522f2559075ff8d2fea780a1ae` |
| orjson | 3.13.0 | MPL-2.0 AND (Apache-2.0 OR MIT) | https://pypi.org/project/orjson/3.13.0/ — `d1de5eb04485110c5da4c657e49168995d55e076b1ce60f1a042e254f4186c4f` |
| tqdm | 4.67.3 | MPL-2.0 AND MIT | https://pypi.org/project/tqdm/4.67.3/ — `7d825f03f89244ef73f1d4ce193cb1774a8179fd96f31d7e1dcde62092b960bb` |

The written offer below covers them like the components above.

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
