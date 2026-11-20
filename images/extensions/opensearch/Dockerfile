# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# OpenSearch with the `repository-s3` snapshot plugin (WP-21, design 02 step 3).
#
# WHY OUR OWN IMAGE. `repository-s3` is not in the official image; the upstream docs say to
# install it and, for Docker, to build an image with `opensearch-plugin install --batch
# repository-s3` (https://docs.opensearch.org/3.7/tuning-your-cluster/availability-and-recovery/snapshots/snapshot-restore/).
# Installing at pod start (`plugins.installList`) cannot work here: the namespace denies
# egress by default, so only build time may download.
#
# The base is the image that runs live (3.7.0), pinned by its multi-arch index digest. The
# 3.10.0 rebase is WP-23 (design 02 step 6) — change BOTH lines below then, never one.
# `opensearch-plugin install <name>` resolves the official plugin zip for exactly the core's
# version and verifies its signature, so the plugin version cannot drift from the base.
FROM opensearchproject/opensearch:3.7.0@sha256:44ba7ea58a319adf61c33ab16873f9ef5dbb30b291a832d375172f0b2d24e3c9

RUN /usr/share/opensearch/bin/opensearch-plugin install --batch repository-s3 \
 && /usr/share/opensearch/bin/opensearch-plugin list | grep -qx repository-s3

LABEL org.opencontainers.image.source="https://github.com/Data-Masterclass/sovereign-agentic-os" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.description="OpenSearch 3.7.0 + repository-s3 (Sovereign Agentic OS)"
