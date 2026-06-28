#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# Pull the poet agent's poems out of the cluster to ./poems/ on this machine,
# so you can open them. Re-run any time to sync the latest. Local/kind only.
set -euo pipefail

NS="${NS:-agentic-os}"
DEST="${1:-poems}"

POD="$(kubectl -n "$NS" get pod -l app.kubernetes.io/component=poet-agent \
        -o jsonpath='{.items[0].metadata.name}')"

mkdir -p "$DEST"
# tar over exec is more robust than `kubectl cp` for a directory of files.
kubectl -n "$NS" exec "$POD" -- sh -c 'cd /data/poems && tar cf - .' | tar xf - -C "$DEST"

echo "Synced poems to ./$DEST/ :"
ls -1 "$DEST"
