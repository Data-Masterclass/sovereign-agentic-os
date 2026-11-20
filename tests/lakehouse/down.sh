#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# Stop the lakehouse harness and remove its containers, volumes and work dir.
set -euo pipefail
cd "$(dirname "$0")/../.."
STATE="${TMPDIR:-/tmp}/${LH_PROJECT:-soa-lakehouse}.work"
WORK=$( [ -f "$STATE" ] && cat "$STATE" || true )
if [ -n "$WORK" ] && [ -f "$WORK/compose.all.env" ]; then
  docker compose -f tests/lakehouse/compose.yaml --env-file "$WORK/compose.all.env" down -v --remove-orphans
else
  # No env file (a failed render): every container of the project still goes, by label.
  ids=$(docker ps -aq --filter label=com.docker.compose.project=${LH_PROJECT:-soa-lakehouse})
  [ -z "$ids" ] || docker rm -fv $ids >/dev/null
fi
[ -z "$WORK" ] || rm -rf "$WORK"
rm -f "$STATE"
