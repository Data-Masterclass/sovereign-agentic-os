#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Restore drill, Postgres part 1 of 2 (WP-56 §3): download the NEWEST pg-dump run
# (templates/extensions/backup/pg-dump-cronjob.yaml writes s3://<bucket>/<prefix>/<UTC-stamp>/)
# into $DRILL_DATA/pg. Part 2 (drill-pg.sh) restores it in the postgres image. A missing or
# empty run is written as the Postgres result here, so it can never be reported as a pass.
set -u
. "${BACKUP_LIB:-/opt/soa/backup/lib.sh}"
: "${PG_DUMP_PREFIX:?}" "${DRILL_DATA:?}" "${RESULTS_DIR:?}"
D="$DRILL_DATA/pg"; mkdir -p "$D"
fail() {
  jq -n --arg r "$1" --arg at "$(now_iso)" '{check:"postgres", status:"fail", reason:$r, at:$at}' > "$RESULTS_DIR/postgres.json"
  log restore-drill fail check postgres reason "$1"; exit 0
}
s3api list-objects-v2 --bucket "$S3_BUCKET" --prefix "$PG_DUMP_PREFIX/" --query 'Contents[].Key' --output json > "$D/keys.json" 2>"$D/err" \
  || fail "listing s3://$S3_BUCKET/$PG_DUMP_PREFIX failed: $(head -c 200 "$D/err")"
STAMP=$(jq -r '.[]? // empty' "$D/keys.json" | sed -n "s#^$PG_DUMP_PREFIX/\([^/]*\)/MANIFEST\$#\1#p" | LC_ALL=C sort | tail -n1)
[ -n "$STAMP" ] || fail "no pg-dump run with a MANIFEST under s3://$S3_BUCKET/$PG_DUMP_PREFIX/"
for key in $(jq -r '.[]' "$D/keys.json" | grep "^$PG_DUMP_PREFIX/$STAMP/"); do
  get_file "$key" "$D/$(basename "$key")" || fail "download of $key failed"
done
ls "$D"/*.dump >/dev/null 2>&1 || fail "run $STAMP holds no database dump"
echo "$STAMP" > "$D/SOURCE"
chmod -R a+rX "$D"
log restore-drill fetched check postgres run "$STAMP" files "$(ls "$D" | wc -l | tr -d ' ')"
