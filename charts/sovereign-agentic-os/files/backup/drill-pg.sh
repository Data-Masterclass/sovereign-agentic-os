#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Restore drill, Postgres part 2 of 2 (WP-56 §3). Runs in the chart's postgres image (the same
# major as the server that wrote the dump). It starts a SCRATCH Postgres inside the drill pod and
# restores the dump drill-pg-fetch.sh downloaded, then compares it with the LIVE server
# (read-only queries only):
#   - the set of databases in the dump equals the live set (non-template, not `postgres`, minus
#     $PG_DRILL_IGNORE_DATABASES);
#   - globals.sql (roles) and every <db>.dump restore (`pg_restore --exit-on-error`);
#   - per database: at least one table and at least one row — an empty dump is refused;
#   - per table: the table exists on both sides, and the restored row count is within
#     $PG_DRILL_MAX_DRIFT_PCT % of the live count (the dump is up to a day older than live; at
#     least $PG_DRILL_MIN_DRIFT_ROWS rows of slack);
#   - every table in $PG_DRILL_CRITICAL_TABLES ("db:schema.table …") has rows in the restore.
# Then it DELETES what it restored: the scratch cluster and the downloaded dumps, including
# globals.sql with its role password hashes — immediately, whatever the outcome.
# Upstream: https://www.postgresql.org/docs/17/app-pgrestore.html
# Writes $RESULTS_DIR/postgres.json (unless part 1 already wrote a failure).
set -u
: "${DRILL_DATA:?}" "${RESULTS_DIR:?}" "${LIVE_PGHOST:?}" "${LIVE_PGUSER:?}"
mkdir -p "$RESULTS_DIR" || { echo "FATAL: cannot create $RESULTS_DIR"; exit 1; }
OUT="$RESULTS_DIR/postgres.json"
D="$DRILL_DATA/pg"; PGD=/tmp/pgdata; SOCK=/tmp/pgsock
DRIFT=${PG_DRILL_MAX_DRIFT_PCT:-25}; MINROWS=${PG_DRILL_MIN_DRIFT_ROWS:-10}
IGNORE=" ${PG_DRILL_IGNORE_DATABASES:-} "; CRITICAL=" ${PG_DRILL_CRITICAL_TABLES:-} "
wipe() { pg_ctl -D "$PGD" -m immediate stop >/dev/null 2>&1; rm -rf "$PGD" "$SOCK" "$DRILL_DATA"; }
if [ -f "$OUT" ]; then echo "postgres: part 1 already reported: $(cat "$OUT")"; wipe; exit 0; fi
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\t' '  '; }
SOURCE=$(cat "$D/SOURCE" 2>/dev/null)
result() { # result STATUS REASON DBS_JSON
  wipe
  printf '{"check":"postgres","status":"%s","reason":"%s","at":"%s","source":"%s","databases":%s}\n' \
    "$1" "$(esc "$2")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SOURCE" "${3:-[]}" > "$OUT"
  printf '{"ts":"%s","event":"restore-drill","status":"%s","check":"postgres","reason":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$(esc "$2")"
  exit 0
}
live() { PGPASSWORD=${LIVE_PGPASSWORD:-} PGOPTIONS='-c default_transaction_read_only=on' psql -h "$LIVE_PGHOST" -p "${LIVE_PGPORT:-5432}" -U "$LIVE_PGUSER" -v ON_ERROR_STOP=1 -Atq "$@"; }
scratch() { psql -h "$SOCK" -U drill -v ON_ERROR_STOP=1 -Atq "$@"; }
TABLES_SQL="SELECT n.nspname||'.'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' ORDER BY 1"
qident() { printf '"%s"."%s"' "${1%%.*}" "${1#*.}"; }

[ -n "$SOURCE" ] || result fail "no downloaded dump (part 1 did not run)"
LIVE_DBS=$(live -d postgres -c "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY 1" 2>/tmp/live.err) \
  || result fail "the live server is unreadable for the comparison: $(head -c 200 /tmp/live.err)"
live_set=$(for d in $LIVE_DBS; do case $IGNORE in *" $d "*) ;; *) echo "$d" ;; esac; done | sort)
dump_set=$(for f in "$D"/*.dump; do d=$(basename "$f" .dump); case $IGNORE in *" $d "*) ;; *) echo "$d" ;; esac; done | sort)
[ "$live_set" = "$dump_set" ] || result fail "the dump's databases [$(echo $dump_set)] differ from live [$(echo $live_set)]"

mkdir -p "$SOCK"
initdb -D "$PGD" -U drill --auth=trust >/tmp/initdb.log 2>&1 || result fail "initdb failed: $(tail -n 3 /tmp/initdb.log)"
pg_ctl -D "$PGD" -o "-c listen_addresses='' -k $SOCK" -w -l /tmp/pg.log start >/dev/null || result fail "scratch postgres did not start: $(tail -n 3 /tmp/pg.log)"
if [ -f "$D/globals.sql" ]; then
  # Roles from the live cluster. "already exists" for the bootstrap role is expected; any OTHER
  # error is a failure.
  psql -h "$SOCK" -U drill -d postgres -q -f "$D/globals.sql" >/tmp/globals.log 2>&1
  if grep -v 'already exists' /tmp/globals.log | grep -q 'ERROR'; then result fail "globals.sql: $(grep ERROR /tmp/globals.log | grep -v 'already exists' | head -n 2)"; fi
fi

dbs="[" fails=0 first=1
for db in $dump_set; do
  f="$D/$db.dump"; status=pass reason="" rows=0 ntab=0
  if ! createdb -h "$SOCK" -U drill "$db" 2>/tmp/c.err; then status=fail reason="createdb: $(head -c 200 /tmp/c.err)"
  elif ! pg_restore -h "$SOCK" -U drill --exit-on-error --no-owner --no-acl -d "$db" "$f" 2>/tmp/r.err; then status=fail reason="pg_restore: $(head -c 300 /tmp/r.err)"
  else
    scratch -d "$db" -c "$TABLES_SQL" > /tmp/restored.tables
    live -d "$db" -c "$TABLES_SQL" > /tmp/live.tables 2>/tmp/live.err || { status=fail; reason="live tables unreadable: $(head -c 200 /tmp/live.err)"; }
    ntab=$(wc -l < /tmp/restored.tables | tr -d ' ')
    if [ "$status" = pass ] && [ "$ntab" -eq 0 ]; then status=fail reason="the dump of '$db' holds no table (an empty dump is not a backup)"; fi
    if [ "$status" = pass ] && ! cmp -s /tmp/restored.tables /tmp/live.tables; then
      status=fail reason="tables differ from live: $(diff /tmp/restored.tables /tmp/live.tables | grep '^[<>]' | head -n 4 | tr '\n' ';')"
    fi
    if [ "$status" = pass ]; then
      while read -r t; do
        r=$(scratch -d "$db" -c "SELECT count(*) FROM $(qident "$t")") || { status=fail reason="count on restored $t failed"; break; }
        l=$(live -d "$db" -c "SELECT count(*) FROM $(qident "$t")") || { status=fail reason="count on live $t failed"; break; }
        rows=$((rows + r))
        d=$(( r > l ? r - l : l - r )); slack=$(( l * DRIFT / 100 )); [ "$slack" -lt "$MINROWS" ] && slack=$MINROWS
        if [ "$d" -gt "$slack" ]; then status=fail reason="$t: restored $r rows, live $l (beyond ${DRIFT}% / ${MINROWS} rows)"; break; fi
        case $CRITICAL in *" $db:$t "*) [ "$r" -gt 0 ] || { status=fail reason="critical table $t is empty in the restore"; break; } ;; esac
      done < /tmp/restored.tables
      if [ "$status" = pass ] && [ "$rows" -eq 0 ]; then status=fail reason="the dump of '$db' restores with 0 rows in $ntab table(s)"; fi
      [ "$status" = pass ] && reason="$ntab table(s), $rows row(s); every table within ${DRIFT}% of live"
    fi
  fi
  [ "$status" = pass ] || fails=$((fails+1))
  [ $first = 1 ] || dbs="$dbs,"; first=0
  dbs="$dbs{\"database\":\"$(esc "$db")\",\"status\":\"$status\",\"tables\":$ntab,\"rows\":$rows,\"reason\":\"$(esc "$reason")\"}"
done
dbs="$dbs]"
[ $first = 0 ] || result fail "no database dump in the run" "$dbs"
if [ $fails -eq 0 ]; then result pass "every database of run $SOURCE restored into a scratch server and matched live" "$dbs"
else result fail "$fails database(s) failed the drill" "$dbs"; fi
