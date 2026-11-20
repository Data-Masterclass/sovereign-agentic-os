#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
P=${SOA_BK_PREFIX:-soa-bk}
docker rm -f "$P-s3" "$P-pg" >/dev/null 2>&1 || true
docker network rm "$P" >/dev/null 2>&1 || true
