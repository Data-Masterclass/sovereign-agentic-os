# Written offer for corresponding source — copyleft components

The Sovereign Agentic OS bundles two copyleft-licensed components as **separate,
unmodified services** (mere aggregation — they are not linked into or derived from
Borek Data Ventures UG's own Apache-2.0 code). This file records the exact upstream
source so the "corresponding source" is locatable, and constitutes a written offer
to provide that source for the air-gapped image bundle.

We redistribute these components **unmodified** (pinned upstream container images).
We make no changes to their source. Their corresponding source is the upstream
release identified below.

---

## Forgejo — GPL-3.0-or-later (separate service / mere aggregation)

- Component: Forgejo (self-hosted Git, Layer 3 software delivery)
- License: GPL-3.0-or-later (full text: `licenses/GPL-3.0.txt`)
- Upstream source repository: https://codeberg.org/forgejo/forgejo
- Distributed version: `11` line (chart `forgejo` 17.1.1, image
  `code.forgejo.org/forgejo/forgejo:11-rootless`)
- Pinned release at packaging time: **v11.0.15**
- Source commit: **a32151caf6b539640578f203a6feb51bb5603160**
- Source tarball (corresponding source):
  https://codeberg.org/forgejo/forgejo/archive/v11.0.15.tar.gz
- Related: Forgejo Runner image `code.forgejo.org/forgejo/runner:6` — source at
  https://code.forgejo.org/forgejo/runner (MIT).

Forgejo runs as its own pod/Deployment and communicates over the network with the
rest of the platform. It is not statically or dynamically linked into any Data
Masterclass code. Distributing it alongside our Apache-2.0 work is **aggregation**
under GPLv3 §5; the GPL applies to Forgejo only.

## Featureform — MPL-2.0 (optional; off by default)

- Component: Featureform (virtual feature store, Layer 4 / Science — `ml.enabled=false`)
- License: MPL-2.0 (full text: `licenses/MPL-2.0.txt`)
- Upstream source repository: https://github.com/featureform/featureform
- Distributed version: latest stable release **v0.12.1**
  (tag `v0.12.2` also exists upstream; pin the tag actually shipped in a given
  release of this product)
- Source commit (v0.12.1): **9ac091f4e377f79312fca393da86694d71ffb5b4**
- Source commit (v0.12.2): **d42305e0a0e05550e612730a4b436c92386c3e3d**
- Source tarball (corresponding source):
  https://github.com/featureform/featureform/archive/refs/tags/v0.12.1.tar.gz

MPL-2.0 is file-level copyleft: it obliges source availability for MPL-covered
files only, and is satisfied by pointing to the unmodified upstream source above.
Featureform is an optional component (Layer 4 Science, disabled by default).

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

Contact: contact@datamasterclass.com
