#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# lock.sh — regenerate requirements.lock (hash-pinned) from requirements.in + upstream-constraints.txt.
#
# Runs uv inside the SAME python base the Dockerfile builds on, so the markers are the image's
# (linux, CPython 3.13). `--generate-hashes` records every published file of each pinned version,
# so one lock serves linux/amd64 (CI, the cluster) and linux/arm64 (a laptop build).
# `--no-emit-package` keeps psycopg-binary (LGPL-3.0 plus its own bundled libpq build) and hf-xet
# (declared by huggingface-hub; embeds MPL-2.0 crates) out; the Dockerfile installs with --no-deps, so
# pip never re-adds them (docs/components/litellm-oss.md "What is left out").
set -euo pipefail
cd "$(dirname "$0")"
BASE=$(sed -n 's/^ARG PYTHON_BASE=//p' Dockerfile)
UV_VERSION=0.9.5
docker run --rm -v "$PWD":/w -w /w "$BASE" sh -ec "
  pip install --quiet --no-cache-dir uv==$UV_VERSION
  uv pip compile requirements.in \
    --constraint upstream-constraints.txt \
    --python-version 3.13 --python-platform x86_64-manylinux_2_28 \
    --generate-hashes --no-header --no-annotate \
    --no-emit-package psycopg-binary --no-emit-package hf-xet \
    --output-file requirements.lock
"
# Guard: the lock must never contain the proprietary package or the excluded copyleft ones.
if grep -Eiq '^(litellm-enterprise|litellm_enterprise|psycopg-binary|restrictedpython|soundfile|hf-xet)==' requirements.lock; then
  echo "lock.sh: requirements.lock contains an excluded package" >&2; exit 1
fi
echo "requirements.lock: $(grep -c '==' requirements.lock) pinned distributions"
