#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# image-label.sh <repository[:tag]@sha256:…> <label> — the value of one OCI config label of a
# pinned image, read from the REGISTRY (read-only: crane config / skopeo inspect --config).
# =============================================================================
# Prints the value (an EMPTY line when the image carries no such label). Exits non-zero when the
# image config cannot be read at all — callers refuse on that, they never read it as "no label".
# DEPLOY_IMAGE_LABEL_PROBE=<cmd> replaces the registry call (tests): `<cmd> <ref>` prints the
# image config JSON.
set -euo pipefail
REF=${1:?usage: image-label.sh <ref@digest> <label>}
LABEL=${2:?usage: image-label.sh <ref@digest> <label>}
case $REF in *@sha256:*) ;; *) echo "IMAGE_LABEL_NOT_PINNED — '$REF' has no @sha256 digest" >&2; exit 2 ;; esac

if [ -n "${DEPLOY_IMAGE_LABEL_PROBE:-}" ]; then
  cfg=$($DEPLOY_IMAGE_LABEL_PROBE "$REF")
elif command -v crane >/dev/null 2>&1; then
  cfg=$(crane config "$REF")
elif command -v skopeo >/dev/null 2>&1; then
  cfg=$(skopeo inspect --config "docker://$REF")
else
  echo "NO_REGISTRY_TOOL — install crane or skopeo to read the image label of $REF" >&2
  exit 1
fi
printf '%s' "$cfg" | python3 -c '
import json, sys
try:
    c = json.load(sys.stdin)
except Exception as e:
    print(f"IMAGE_CONFIG_UNREADABLE — {e}", file=sys.stderr); sys.exit(1)
if not isinstance(c, dict) or not isinstance(c.get("config", {}), dict):
    print("IMAGE_CONFIG_UNREADABLE — not an OCI image config", file=sys.stderr); sys.exit(1)
labels = (c.get("config") or {}).get("Labels") or {}
print(labels.get(sys.argv[1], ""))' "$LABEL"
