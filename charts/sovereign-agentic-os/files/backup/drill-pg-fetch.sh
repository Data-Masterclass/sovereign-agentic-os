#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Restore drill, Postgres part 1 of 2 (WP-56 §3): download the NEWEST pg-dump run
# (templates/extensions/backup/pg-dump-cronjob.yaml writes s3://<bucket>/<prefix>/<UTC-stamp>/)
# into $DRILL_DATA/pg. Part 2 (drill-pg.sh) restores it in the postgres image and deletes it.
# A missing, empty or STALE run (older than $PG_DRILL_MAX_AGE_HOURS) is written as the Postgres
# result here, so it can never be reported as a pass.
set -u
. "${BACKUP_LIB:-/opt/soa/backup/lib.sh}"
: "${PG_DUMP_PREFIX:?}" "${DRILL_DATA:?}" "${RESULTS_DIR:?}"
MAX_AGE_H=${PG_DRILL_MAX_AGE_HOURS:-26}
mkdir -p "$RESULTS_DIR" || { echo "FATAL: cannot create $RESULTS_DIR"; exit 1; }
D="$DRILL_DATA/pg"; mkdir -p "$D"
fail() {
  rm -rf "$D"
  jq -n --arg r "$1" --arg at "$(now_iso)" '{check:"postgres", status:"fail", reason:$r, at:$at}' > "$RESULTS_DIR/postgres.json"
  log restore-drill fail check postgres reason "$1"; exit 0
}
s3api list-objects-v2 --bucket "$S3_BUCKET" --prefix "$PG_DUMP_PREFIX/" --query 'Contents[].Key' --output json > "$D/keys.json" 2>"$D/err" \
  || fail "listing s3://$S3_BUCKET/$PG_DUMP_PREFIX failed: $(head -c 200 "$D/err")"
STAMP=$(jq -r '.[]? // empty' "$D/keys.json" | sed -n "s#^$PG_DUMP_PREFIX/\([^/]*\)/MANIFEST\$#\1#p" | LC_ALL=C sort | tail -n1)
[ -n "$STAMP" ] || fail "no pg-dump run with a MANIFEST under s3://$S3_BUCKET/$PG_DUMP_PREFIX/"
# The run's stamp is its UTC start (2026-11-20T02-30-00Z). Older than the limit = the dump job
# stopped working, and a drill of an old dump proves nothing about today's data.
when=$(printf '%s' "$STAMP" | sed -n 's/^\([0-9-]*\)T\([0-9][0-9]\)-\([0-9][0-9]\)-\([0-9][0-9]\)Z$/\1 \2:\3:\4/p')
[ -n "$when" ] || fail "unreadable run stamp '$STAMP'"
epoch=$(date -u -d "$when" +%s 2>/dev/null) || fail "unreadable run stamp '$STAMP'"
age_h=$(( ($(date -u +%s) - epoch) / 3600 ))
[ "$age_h" -le "$MAX_AGE_H" ] || fail "the newest pg-dump run ($STAMP) is ${age_h} h old, above the ${MAX_AGE_H} h limit: the dump job is not producing backups"
for key in $(jq -r '.[]' "$D/keys.json" | grep "^$PG_DUMP_PREFIX/$STAMP/"); do
  get_file "$key" "$D/$(basename "$key")" || fail "download of $key failed"
done
ls "$D"/*.dump >/dev/null 2>&1 || fail "run $STAMP holds no database dump"
rm -f "$D/keys.json" "$D/err"
echo "$STAMP" > "$D/SOURCE"
log restore-drill fetched check postgres run "$STAMP" age_h "$age_h" files "$(ls "$D" | wc -l | tr -d ' ')"
