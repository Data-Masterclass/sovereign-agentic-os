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
# the default is `ghcr.io/data-masterclass/sovereign-os` (option A, taken 2026-11-19). A release
# that still carries `ghcr.io/aborek/sovereign-os/os-ui` — one never moved, or one moved back by
# a local `IMAGE_REPO=ghcr.io/aborek/sovereign-os` build — would have a plain
# `./scripts/deploy.sh --from-registry 0.9.6` pin the data-masterclass digest against the
# aborek repository. The digest does not exist there, so every os-ui pod goes
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


def repository_of(path: str):
    """osUI.image.repository from a values file, or None (missing file, not a mapping, unset)."""
    try:
        with open(path) as fh:
            values = yaml.safe_load(fh) or {}
    except FileNotFoundError:
        return None
    if not isinstance(values, dict):
        return None
    image = (values.get("osUI") or {}).get("image") or {}
    return image.get("repository") if isinstance(image, dict) else None


def main() -> int:
    if len(sys.argv) not in (3, 4):
        print(
            "usage: check-image-repo.py <values.yaml> <expected-repository> [<chart-values.yaml>]",
            file=sys.stderr,
        )
        return 2
    values_path, expected = sys.argv[1], sys.argv[2]
    chart_path = sys.argv[3] if len(sys.argv) == 4 else None

    found = repository_of(values_path)
    if not found:
        # NO REPOSITORY IN THE DERIVED VALUES IS NOT AUTOMATICALLY SAFE (review L3). The CHART
        # DEFAULT then applies — and that default is the laptop/kind profile, an unprefixed
        # `sovereign-os/os-ui` that no registry serves. Deploying a `ghcr.io/...` digest against
        # it is the same ImagePullBackOff by another route, so compare against the default
        # rather than waving it through.
        if not chart_path:
            print("   the derived values pin no osUI.image.repository — the chart default applies")
            return 0
        default = repository_of(chart_path)
        if not default:
            print(f"   neither {values_path} nor {chart_path} pins osUI.image.repository")
            return 0
        if default == expected:
            print(f"   the derived values pin no repository; the chart default matches ({default})")
            return 0
        print(
            "\nIMAGE_REPOSITORY_MISMATCH — refusing to deploy.\n"
            f"   the derived values pin NO osUI.image.repository, so the chart default applies\n"
            f"   the chart default ({chart_path}) is : {default}\n"
            f"   this run would pin a digest from   : {expected}\n"
            "\n   The chart default is the laptop/kind profile — a bare name no registry serves —\n"
            "   so the pods would never pull this digest. Either pass\n"
            f"     IMAGE_REPO={expected.rsplit('/', 1)[0]} ./scripts/deploy.sh <version>\n"
            "   (which also --sets osUI.image.repository), or set the repository in the release's\n"
            "   own values first.\n",
            file=sys.stderr,
        )
        return 1
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
