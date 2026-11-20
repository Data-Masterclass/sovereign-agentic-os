# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# backup-tools — the image of the WP-56 git backup and restore drills: the `git-backup` sidecar
# on the os-ui pod (git bundle -> object storage) and the restore-drill Jobs.
#
# Why our own image: the work needs git's own CLI (`git bundle create/verify`, `git fsck` —
# isomorphic-git, the OS's writer, has no bundle support), an S3 client (aws-cli v2) and jq in
# ONE process environment. No stock image has all three; amazon/aws-cli has no git, alpine/git
# no S3 client. Every package is a distro package at a pinned version, and the build FAILS when
# a tool is missing.
#
# Licences: git GPL-2.0 (a separate process, never linked), aws-cli Apache-2.0, jq MIT,
# curl curl-licence (MIT-style), openssl Apache-2.0.
FROM alpine:3.21@sha256:bc21487101ae47172509130ee1092cc273a831968d64b617776d1f69c81e42ab
RUN apk add --no-cache \
      git=2.47.3-r0 aws-cli=2.22.10-r0 jq=1.8.2-r0 curl=8.14.1-r3 openssl=3.3.7-r2 \
 && git --version && aws --version && jq --version && curl --version | head -n1 && openssl version
# The chart runs it non-root with a read-only root filesystem; scripts write only to /tmp
# (an emptyDir) and the shared queue volume.
USER 65532:65532
ENV HOME=/tmp
ENTRYPOINT ["/bin/sh"]
