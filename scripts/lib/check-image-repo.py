#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# check-image-repo.py <derived-values.yaml> <expected-repository>
# =============================================================================
# Refuse a deploy that would pin a digest from one registry namespace against a chart that pulls
# from another (review M3).
#
# THE FAILURE IT PREVENTS. `scripts/deploy.sh` pins the image by DIGEST
# (`--set osUI.image.tag=<version>@sha256:…`) but takes the image REPOSITORY from the live
# release's own values — the night-1 rule that the chart owns the tag and the operator owns the
# repository. Those two halves come from different places, so they can disagree. Concretely:
# once the owner moves image builds to `ghcr.io/data-masterclass/sovereign-os` (option A) and
# the release carries that repository, a plain `./scripts/deploy.sh 0.9.6` would still build and
# push to the DEFAULT `ghcr.io/aborek/sovereign-os`, then pin that digest against the
# data-masterclass repository. The digest does not exist there, so every os-ui pod goes
# ImagePullBackOff — after the backup gate ran, after the image was built and pushed, and with
# the previous ReplicaSet already scaled down.
#
# A digest is only meaningful inside one repository, so there is no safe way to guess here:
# refuse, and name the two commands that fix it.
#
# Exit 0 when they agree, or when the values carry no repository at all (the chart default then
# applies and the operator is on the laptop profile). Exit 1 with the explanation otherwise.
import sys

import yaml


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: check-image-repo.py <values.yaml> <expected-repository>", file=sys.stderr)
        return 2
    values_path, expected = sys.argv[1], sys.argv[2]
    try:
        with open(values_path) as fh:
            values = yaml.safe_load(fh) or {}
    except FileNotFoundError:
        print(f"   no derived values at {values_path} — image repository not checked")
        return 0
    if not isinstance(values, dict):
        print(f"   {values_path} is not a mapping — image repository not checked")
        return 0

    image = ((values.get("osUI") or {}).get("image") or {})
    found = image.get("repository") if isinstance(image, dict) else None
    if not found:
        print("   the derived values pin no osUI.image.repository — the chart default applies")
        return 0
    if found == expected:
        print(f"   osUI.image.repository matches the image being deployed ({found})")
        return 0

    print(
        "\nIMAGE_REPOSITORY_MISMATCH — refusing to deploy.\n"
        f"   the live release pulls os-ui from : {found}\n"
        f"   this run would pin a digest from  : {expected}\n"
        "\n   A digest only exists inside ONE repository, so this would leave every os-ui pod in\n"
        "   ImagePullBackOff — after the backup gate, after the push, with the old ReplicaSet\n"
        "   already scaled down. Pick one of:\n"
        f"\n     IMAGE_REPO={found.rsplit('/', 1)[0]} ./scripts/deploy.sh <version>"
        "        # build and push where the release already pulls from"
        f"\n     IMAGE_REPO={expected.rsplit('/', 1)[0]} ./scripts/deploy.sh <version>"
        "        # move the release to this namespace (also --sets the repository)\n",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
