#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# image-label.test.sh — scripts/lib/image-label.sh reads one OCI label of a PINNED image from the
# registry (crane, else skopeo), prints "" when the label is absent, and FAILS when the config
# cannot be read — never reporting an unreadable image as "no label".
# =============================================================================
#   bash scripts/tests/image-label.test.sh
# Stubbed crane / skopeo first on PATH: no registry, no network.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
REF=ghcr.io/data-masterclass/sovereign-os/data-runner:0.3.0@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
L=org.sovereign-os.applies-column-names
mk() { # <dir> <tool> <behaviour>
  mkdir -p "$1"
  case $3 in
    true)   printf '#!/usr/bin/env bash\necho "$0 $*" >> "%s/calls"\necho %s\n' "$TMP" "'{\"config\":{\"Labels\":{\"$L\":\"true\"}}}'" > "$1/$2" ;;
    absent) printf '#!/usr/bin/env bash\necho "$0 $*" >> "%s/calls"\necho %s\n' "$TMP" "'{\"config\":{\"Labels\":null}}'" > "$1/$2" ;;
    fail)   printf '#!/usr/bin/env bash\necho "unauthorized" >&2\nexit 1\n' > "$1/$2" ;;
    junk)   printf '#!/usr/bin/env bash\necho "<html>proxy error</html>"\n' > "$1/$2" ;;
  esac
  chmod +x "$1/$2"
}
run() { out=$(env -u DEPLOY_IMAGE_LABEL_PROBE PATH="$1:$PATH" bash scripts/lib/image-label.sh "$2" "$L" 2>&1); rc=$?; }

mk "$TMP/c1" crane true;   run "$TMP/c1" "$REF"
[ $rc = 0 ] && [ "$out" = true ] && ok "crane: the label value" || bad "crane: the label value" "rc=$rc out=$out"
check "crane reads the image config of the pinned digest" "crane config $REF" "$(cat "$TMP/calls")"
mk "$TMP/c2" crane absent; run "$TMP/c2" "$REF"
[ $rc = 0 ] && [ -z "$out" ] && ok "an image without the label prints an empty value" || bad "an image without the label prints an empty value" "rc=$rc out=$out"
mk "$TMP/c3" crane fail;   run "$TMP/c3" "$REF"
[ $rc != 0 ] && ok "fail closed: the registry refused" || bad "fail closed: the registry refused" "rc=$rc out=$out"
mk "$TMP/c4" crane junk;   run "$TMP/c4" "$REF"
[ $rc != 0 ] && ok "fail closed: an answer that is not an image config" || bad "fail closed: an answer that is not an image config" "rc=$rc out=$out"
run "$TMP/c1" "${REF%@*}"
[ $rc != 0 ] && check "an unpinned reference is refused" "IMAGE_LABEL_NOT_PINNED" "$out" || bad "an unpinned reference is refused" "rc=$rc"
# skopeo path: a PATH holding only a skopeo stub (no crane) plus the basics.
mkdir -p "$TMP/s"; for b in bash python3 env cat; do ln -s "$(command -v $b)" "$TMP/s/$b"; done
mk "$TMP/s" skopeo true; : > "$TMP/calls"
out=$(env -u DEPLOY_IMAGE_LABEL_PROBE PATH="$TMP/s" bash scripts/lib/image-label.sh "$REF" "$L" 2>&1); rc=$?
[ $rc = 0 ] && [ "$out" = true ] && ok "skopeo: the label value" || bad "skopeo: the label value" "rc=$rc out=$out"
check "skopeo reads the config of the pinned digest" "skopeo inspect --config docker://$REF" "$(cat "$TMP/calls")"
rm "$TMP/s/skopeo"
out=$(env -u DEPLOY_IMAGE_LABEL_PROBE PATH="$TMP/s" bash scripts/lib/image-label.sh "$REF" "$L" 2>&1); rc=$?
[ $rc != 0 ] && check "no registry tool: refused" "NO_REGISTRY_TOOL" "$out" || bad "no registry tool: refused" "rc=$rc out=$out"

finish image-label
