#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
P=${SOA_IT_PREFIX:-soa-it}
docker rm -f "$P-opensearch" "$P-proxy" "$P-s3store" >/dev/null 2>&1 || true
docker network rm "$P-os" "$P-s3" >/dev/null 2>&1 || true
echo "down.sh: removed $P stack"
