#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# promote-image.sh — give an image that already exists a second tag, WITHOUT rebuilding it.
# =============================================================================
#   bash scripts/lib/promote-image.sh <source ref> <destination ref>
#   e.g. ghcr.io/data-masterclass/sovereign-os/os-ui:main-<sha>  ->  ...:0.9.22
#
# WHY. Production must run the bytes that passed dev. A rebuild of the same commit is a different
# image (timestamps, base-image drift), so a release re-tags the dev image instead. The copy is a
# registry-side tag of the SAME manifest; afterwards both refs must resolve to the same digest, or
# this exits 1 (`PROMOTE_DIGEST_MISMATCH`).
#
# Tools, first present wins: crane (`crane copy`), skopeo (`skopeo copy --all --preserve-digests`,
# preinstalled on GitHub's ubuntu runners). Registry credentials come from the tool's own login
# (`docker login` / `skopeo login`); nothing here reads or prints a token.
#   bash scripts/lib/promote-image.sh --digest <ref>   prints the digest <ref> resolves to (read-only)
# A source given BY DIGEST (<repo>@sha256:...) is copied by digest: what was tested, not what a
# tag says today.
# PROMOTE_TOOL=<cmd> replaces the copy-and-digest tool in tests: `<cmd> digest <ref>`, `<cmd> copy <src> <dst>`.
set -euo pipefail
DIGEST_ONLY=''
if [ "${1:-}" = --digest ]; then DIGEST_ONLY=1; shift; fi
SRC=${1:?usage: promote-image.sh <source ref> <destination ref>}
DST=${2:-}
[ -n "$DIGEST_ONLY" ] || [ -n "$DST" ] || { echo "usage: promote-image.sh <source ref> <destination ref>" >&2; exit 2; }

digest() {
  if [ -n "${PROMOTE_TOOL:-}" ]; then $PROMOTE_TOOL digest "$1"; return; fi
  if command -v crane >/dev/null 2>&1; then crane digest "$1"; return; fi
  if command -v skopeo >/dev/null 2>&1; then skopeo inspect --format '{{.Digest}}' "docker://$1"; return; fi
  echo "NO_REGISTRY_TOOL — install crane or skopeo" >&2; return 1
}
copy() {
  if [ -n "${PROMOTE_TOOL:-}" ]; then $PROMOTE_TOOL copy "$1" "$2"; return; fi
  if command -v crane >/dev/null 2>&1; then crane copy "$1" "$2"; return; fi
  skopeo copy --all --preserve-digests "docker://$1" "docker://$2"
}

if [ -n "$DIGEST_ONLY" ]; then
  d=$(digest "$SRC" 2>/dev/null || true)
  case $d in sha256:*) echo "$d"; exit 0 ;; *) echo "PROMOTE_SOURCE_MISSING — $SRC does not exist in the registry" >&2; exit 1 ;; esac
fi
src_digest=$(digest "$SRC" 2>/dev/null || true)
case $SRC in
  *@sha256:*) [ "$src_digest" = "${SRC##*@}" ] || { echo "PROMOTE_SOURCE_MISSING — $SRC is not in the registry" >&2; exit 1; } ;;
esac
case $src_digest in
  sha256:*) ;;
  *) echo "PROMOTE_SOURCE_MISSING — $SRC does not exist in the registry" >&2; exit 1 ;;
esac
dst_digest=$(digest "$DST" 2>/dev/null || true)
if [ "$dst_digest" = "$src_digest" ]; then
  echo "PROMOTE_OK $DST already is $src_digest"
  exit 0
fi
if [ -n "$dst_digest" ]; then
  # A tag that already names ANOTHER image is never moved: versions are immutable.
  echo "PROMOTE_REFUSED — $DST already exists with a different digest ($dst_digest)" >&2
  exit 1
fi
copy "$SRC" "$DST"
dst_digest=$(digest "$DST")
[ "$dst_digest" = "$src_digest" ] || { echo "PROMOTE_DIGEST_MISMATCH — $DST is $dst_digest, $SRC is $src_digest" >&2; exit 1; }
echo "PROMOTE_OK $DST = $SRC = $src_digest"
