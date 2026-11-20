#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Restore drill, Postgres part 2 of 2 (WP-56 §3). Runs in the chart's postgres image (the same
# major as the server that wrote the dump). It starts a SCRATCH Postgres inside the drill pod —
# never the live server — and restores the dump that drill-pg-fetch.sh downloaded:
#   - globals.sql (roles) with psql;
#   - every <db>.dump with `pg_restore --exit-on-error` into a database of the same name;
#   - sanity: the restored user tables equal the TABLE entries of the dump's own table of
#     contents (`pg_restore -l`), and `SELECT count(*)` succeeds on every one of them.
# Upstream: https://www.postgresql.org/docs/17/app-pgrestore.html
# Writes $RESULTS_DIR/postgres.json (unless part 1 already wrote a failure).
set -u
: "${DRILL_DATA:?}" "${RESULTS_DIR:?}"
OUT="$RESULTS_DIR/postgres.json"
[ -f "$OUT" ] && { echo "postgres: part 1 already reported: $(cat "$OUT")"; exit 0; }
D="$DRILL_DATA/pg"; PGD=/tmp/pgdata; SOCK=/tmp/pgsock
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\t' '  '; }
result() { # result STATUS REASON DBS_JSON
  printf '{"check":"postgres","status":"%s","reason":"%s","at":"%s","source":"%s","databases":%s}\n' \
    "$1" "$(esc "$2")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(cat "$D/SOURCE" 2>/dev/null)" "${3:-[]}" > "$OUT"
  printf '{"ts":"%s","event":"restore-drill","status":"%s","check":"postgres","reason":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$(esc "$2")"
  pg_ctl -D "$PGD" -m fast stop >/dev/null 2>&1 || true
  exit 0
}
[ -f "$D/SOURCE" ] || result fail "no downloaded dump (part 1 did not run)"
mkdir -p "$SOCK"
initdb -D "$PGD" -U drill --auth=trust >/tmp/initdb.log 2>&1 || result fail "initdb failed: $(tail -n 3 /tmp/initdb.log)"
pg_ctl -D "$PGD" -o "-c listen_addresses='' -k $SOCK" -w -l /tmp/pg.log start >/dev/null || result fail "scratch postgres did not start: $(tail -n 3 /tmp/pg.log)"
export PGHOST=$SOCK PGUSER=drill PGDATABASE=postgres
if [ -f "$D/globals.sql" ]; then
  # Roles from the live cluster. "already exists" for the bootstrap role is expected; any OTHER
  # error is a failure.
  psql -q -f "$D/globals.sql" >/tmp/globals.log 2>&1
  if grep -v 'already exists' /tmp/globals.log | grep -q 'ERROR'; then result fail "globals.sql: $(grep ERROR /tmp/globals.log | grep -v 'already exists' | head -n 2)"; fi
fi
dbs="[" fails=0 first=1
for f in "$D"/*.dump; do
  db=$(basename "$f" .dump)
  want=$(pg_restore -l "$f" | awk '$4=="TABLE" && $5!="DATA"' | wc -l | tr -d ' ')
  status=pass reason="" rows=0
  if ! createdb "$db" 2>/tmp/c.err; then status=fail reason="createdb: $(head -c 200 /tmp/c.err)"
  elif ! pg_restore --exit-on-error --no-owner --no-acl -d "$db" "$f" 2>/tmp/r.err; then status=fail reason="pg_restore: $(head -c 300 /tmp/r.err)"
  else
    got=$(psql -d "$db" -Atc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'")
    if [ "$got" != "$want" ]; then status=fail reason="dump lists $want table(s), restore has $got"
    else
      while IFS='|' read -r s t; do
        [ -z "$t" ] && continue
        n=$(psql -d "$db" -Atc "SELECT count(*) FROM \"$s\".\"$t\"" 2>/tmp/q.err) || { status=fail reason="SELECT count(*) on $s.$t failed: $(head -c 200 /tmp/q.err)"; break; }
        rows=$((rows + n))
      done < <(psql -d "$db" -AtF'|' -c "SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'")
      [ "$status" = pass ] && reason="$got table(s) restored, $rows row(s) counted"
    fi
  fi
  [ "$status" = pass ] || fails=$((fails+1))
  [ $first = 1 ] || dbs="$dbs,"; first=0
  dbs="$dbs{\"database\":\"$(esc "$db")\",\"status\":\"$status\",\"tables\":$want,\"rows\":$rows,\"reason\":\"$(esc "$reason")\"}"
done
dbs="$dbs]"
[ $first = 0 ] || result fail "no database dump in the run" "$dbs"
if [ $fails -eq 0 ]; then result pass "every database of run $(cat "$D/SOURCE") restored into a scratch server and queried" "$dbs"
else result fail "$fails database(s) failed to restore" "$dbs"; fi
