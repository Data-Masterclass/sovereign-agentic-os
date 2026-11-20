#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# Stop the delete-domain harness: its containers, volumes and work dir (its own project only).
set -euo pipefail
cd "$(dirname "$0")/../.."
P=${DD_PROJECT:-soa-domain-delete}
STATE="${TMPDIR:-/tmp}/$P.work"
WORK=$( [ -f "$STATE" ] && cat "$STATE" || true )
ids=$(docker ps -aq --filter "label=com.docker.compose.project=$P")
[ -z "$ids" ] || docker rm -fv $ids >/dev/null
docker network rm "${P}_lh" >/dev/null 2>&1 || true
docker volume rm "${P}_bootstrap-state" >/dev/null 2>&1 || true
[ -z "$WORK" ] || rm -rf "$WORK"
rm -f "$STATE"
