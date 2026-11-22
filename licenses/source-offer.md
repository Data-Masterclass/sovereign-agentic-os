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
