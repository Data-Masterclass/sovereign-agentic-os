#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# WP-13 lakehouse harness: render the chart (render.py), generate throwaway keys, start
# compose.yaml and wait until Trino answers. Idempotent: removes an old stack first.
#
#   bash tests/lakehouse/up.sh [extra helm args, e.g. --set trino.image.tag=484]
#   bash tests/lakehouse/down.sh
#
# The work dir (rendered files + keys) is written to ${TMPDIR:-/tmp}/${LH_PROJECT:-soa-lakehouse}.work.
# LH_PROJECT (compose project) and LH_TRINO_PORT / LH_RUNNER_PORT let two stacks run side by side.
set -euo pipefail
cd "$(dirname "$0")/../.."
bash tests/lakehouse/down.sh >/dev/null 2>&1 || true
# Under $HOME by default, so colima can mount it.
WORK=${LH_WORK:-$(mktemp -d "${LH_WORK_PARENT:-$HOME}/.soa-lakehouse.XXXXXX")}
rand() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
export LH_S3_KEY="ci$(rand 8)" LH_S3_SECRET="$(rand 20)" LH_PG_USER=polaris LH_PG_PASSWORD="$(rand 16)"
python3 tests/lakehouse/render.py "$WORK" "$@"
# restrict.sh re-renders into the same stack, so it needs the same external secrets (mode 600).
( umask 077 && printf 'LH_S3_KEY=%s\nLH_S3_SECRET=%s\nLH_PG_USER=%s\nLH_PG_PASSWORD=%s\n' "$LH_S3_KEY" "$LH_S3_SECRET" "$LH_PG_USER" "$LH_PG_PASSWORD" > "$WORK/harness.env" )
chmod -R a+rX "$WORK"
chmod 600 "$WORK/harness.env" "$WORK/test-secrets.json" 2>/dev/null || true
{ cat "$WORK/compose.env"; echo "LH_WORK=$WORK"; echo "LH_PG_USER=$LH_PG_USER"; echo "LH_PG_PASSWORD=$LH_PG_PASSWORD"; } > "$WORK/compose.all.env"
echo "$WORK" > "${TMPDIR:-/tmp}/${LH_PROJECT:-soa-lakehouse}.work"
if ! docker compose -f tests/lakehouse/compose.yaml --env-file "$WORK/compose.all.env" up -d --build --wait --wait-timeout 600 trino trino-opa data-runner; then
  docker compose -f tests/lakehouse/compose.yaml --env-file "$WORK/compose.all.env" ps -a
  docker compose -f tests/lakehouse/compose.yaml --env-file "$WORK/compose.all.env" logs --tail 80
  exit 1
fi
echo "up.sh: lakehouse up ($(grep LH_TRINO_IMAGE "$WORK/compose.env")), work dir $WORK"
