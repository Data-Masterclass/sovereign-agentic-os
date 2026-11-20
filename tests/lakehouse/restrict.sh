#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# WP-14: move the running lakehouse harness to the CLOSED state — the chart rendered with
# `trino.auth.insecureHttp=false` (Trino refuses every statement on plain HTTP). Only Trino and its OPA are
# recreated (and the central OPA, whose policy files are re-rendered too); Polaris, Postgres and the object store keep their data, so tables written in the
# dual-run phase (and the parity baseline in the work dir) are still there.
#
#   bash tests/lakehouse/up.sh && <dual-run tests> && bash tests/lakehouse/restrict.sh && <closed tests>
set -euo pipefail
cd "$(dirname "$0")/../.."
WORK=$(cat "${TMPDIR:-/tmp}/${LH_PROJECT:-soa-lakehouse}.work")
set -a && . "$WORK/harness.env" && set +a
# Re-render the Trino and OPA files from scratch (a stale policy file must not survive).
mv "$WORK/trino" "$WORK/trino.dual-run" && mv "$WORK/opa" "$WORK/opa.dual-run" && mv "$WORK/trino-opa" "$WORK/trino-opa.dual-run"
python3 tests/lakehouse/render.py "$WORK" --set trino.auth.insecureHttp=false "$@"
chmod -R a+rX "$WORK/trino" "$WORK/opa" "$WORK/trino-opa"
chmod 600 "$WORK/harness.env" "$WORK/test-secrets.json"
{ cat "$WORK/compose.env"; echo "LH_WORK=$WORK"; echo "LH_PG_USER=$LH_PG_USER"; echo "LH_PG_PASSWORD=$LH_PG_PASSWORD"; } > "$WORK/compose.all.env"
grep -q '^http-server.authentication.allow-insecure-over-http=false$' "$WORK/trino/etc/config.properties" \
  || { echo "restrict.sh: the closed render still allows insecure HTTP" >&2; exit 1; }
docker compose -f tests/lakehouse/compose.yaml --env-file "$WORK/compose.all.env" up -d --no-deps --force-recreate --wait --wait-timeout 300 opa trino trino-opa
echo "restrict.sh: Trino recreated in the closed state"
