<!-- SPDX-License-Identifier: Apache-2.0 -->
# Attributions: builder image (MPL-2.0 Go modules, owner exception 2026-11-27)

The App Builder image (`images/base/builder`, `ghcr.io/data-masterclass/sovereign-os/builder`) builds BuildKit
(`moby/buildkit` v0.35.1) and runc (`opencontainers/runc` v1.5.3) unmodified from pinned source. Those upstream
programs statically link the five Go modules below, licensed in whole or in part under MPL-2.0. They are covered by a
**narrow owner exception** (2026-11-27): `licenses/exceptions.images.json`, scope `builder`, enforced by
`scripts/check-builder-sbom.mjs`. Policy, rationale and obligations: `THIRD-PARTY-LICENSES.md`, "Narrow MPL-2.0
exception: the App Builder image". Full MPL-2.0 text: `licenses/MPL-2.0.txt`. Exact sources: `licenses/source-offer.md`.

The image carries the same information in `/licenses/NOTICE` (source: `images/base/builder/licenses/NOTICE`), the
MPL-2.0 text in `/licenses/MPL-2.0.txt`, and each module's own upstream licence files, copied verbatim from the compiled
`vendor/` tree, under `/licenses/go/<module>@<version>/`.

| Module | Version | Licence | Upstream program | Source (unmodified) |
|---|---|---|---|---|
| github.com/hashicorp/go-immutable-radix/v2 | v2.1.0 | MPL-2.0 | BuildKit | https://github.com/hashicorp/go-immutable-radix/tree/v2.1.0 |
| github.com/hashicorp/go-retryablehttp | v0.7.8 | MPL-2.0 | BuildKit | https://github.com/hashicorp/go-retryablehttp/tree/v0.7.8 |
| github.com/hashicorp/go-cleanhttp | v0.5.2 | MPL-2.0 | BuildKit | https://github.com/hashicorp/go-cleanhttp/tree/v0.5.2 |
| github.com/hashicorp/golang-lru/v2 | v2.0.7 | MPL-2.0 AND BSD-3-Clause (`simplelru/list.go`, Go Authors) | BuildKit | https://github.com/hashicorp/golang-lru/tree/v2.0.7 |
| github.com/cyphar/filepath-securejoin | v0.7.0 | BSD-3-Clause AND MPL-2.0 (`pathrs-lite` is MPL-2.0, see its `COPYING.md`) | runc, BuildKit | https://github.com/cyphar/filepath-securejoin/tree/v0.7.0 |

Copyright notices as shipped upstream: go-immutable-radix, go-retryablehttp and golang-lru "Copyright (c) 2014/2015
HashiCorp, Inc."; golang-lru `simplelru/LICENSE_list` "Copyright (c) 2009 The Go Authors"; filepath-securejoin
"Copyright (C) 2014-2015 Docker Inc & Go Authors", "Copyright (C) 2017-2024 SUSE LLC", plus each file's own header.
