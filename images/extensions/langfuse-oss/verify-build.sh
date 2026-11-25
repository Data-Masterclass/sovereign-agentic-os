#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# verify-build.sh <name> <fingerprints> <dir>... — fails the image build if the BUILT output still holds
# Enterprise Edition code:
#   1. a directory of the @langfuse/ee package, or a compiled web/src/ee, worker/src/ee or worker/dist/ee
#      (packages/shared/.../server/ee is MIT under Langfuse's root LICENSE and is allowed);
#   2. any of the fingerprint strings prepare-source.mjs collected from the EE sources (literals that occur
#      nowhere in the MIT source). Fingerprints that also occur in the third-party packages installed
#      before the build (/app/node_modules/.pnpm, not Langfuse code) are dropped first: they cannot tell
#      EE code apart. The run prints how many were dropped.
set -eu
name=$1; fp=$2; shift 2
test -s "$fp" || { echo "verify-build($name): no fingerprint file" >&2; exit 1; }

hits=$(find "$@" \( -type d -o -type l \) \( -path '*/@langfuse/ee' -o -path '*/web/src/ee' -o -path '*/worker/src/ee' \
        -o -path '*/worker/dist/ee' -o -path '*/server/app/*/ee' \) 2>/dev/null || true)
if [ -n "$hits" ]; then echo "verify-build($name): EE directories in the output:" >&2; echo "$hits" >&2; exit 1; fi
# 1b. sharp's LGPL libvips binaries must be gone (Dockerfile removes them).
vips=$(find "$@" -type d -path '*/@img/sharp-libvips*' 2>/dev/null || true)
if [ -n "$vips" ]; then echo "verify-build($name): libvips (LGPL) left in the output:" >&2; echo "$vips" >&2; exit 1; fi
# 1c. Next.js's vendored @vercel/og (MPL-2.0) must be gone (Dockerfile removes it).
og=$(find "$@" -type d -path '*/dist/compiled/@vercel/og' 2>/dev/null || true)
if [ -n "$og" ]; then echo "verify-build($name): @vercel/og (MPL-2.0) left in the output:" >&2; echo "$og" >&2; exit 1; fi

total=$(grep -c . "$fp")
if [ -d /app/node_modules/.pnpm ]; then
  grep -rFoh -f "$fp" /app/node_modules/.pnpm 2>/dev/null | sort -u > /tmp/fp-in-deps || true
  grep -vxF -f /tmp/fp-in-deps "$fp" > /tmp/fp-effective || true
else
  cp "$fp" /tmp/fp-effective
fi
eff=$(grep -c . /tmp/fp-effective || true)
echo "verify-build($name): $total EE fingerprints, $((total - eff)) also in third-party packages (dropped), $eff searched"
[ "$eff" -ge 50 ] || { echo "verify-build($name): too few effective fingerprints ($eff)" >&2; exit 1; }

if found=$(grep -rlF -f /tmp/fp-effective "$@" 2>/dev/null); then
  echo "verify-build($name): EE fingerprints found in the build output:" >&2
  echo "$found" | head -50 >&2
  exit 1
fi
echo "verify-build($name): ok - no EE directory and no EE fingerprint in $*"
