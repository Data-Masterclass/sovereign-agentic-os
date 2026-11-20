#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Restore drill, OpenSearch part (WP-56 §3). Runs in the curl image with the chart's ONE
# OpenSearch shell client (files/opensearch/lib/os-curl.sh). Upstream (3.7):
# https://docs.opensearch.org/3.7/tuning-your-cluster/availability-and-recovery/snapshots/snapshot-restore/
#   0. leftovers of an interrupted drill (any `drill-*` index) are deleted first;
#   1. the newest SUCCESS snapshot of $OS_DRILL_REPO (`_cat/snapshots`, sorted by end time), and
#      it must be younger than $OS_DRILL_MAX_AGE_HOURS — a stale snapshot is a failure;
#   2. `_restore` of its indices ($OS_DRILL_INDICES, hidden ones excluded) under a TEMPORARY
#      prefix (`rename_pattern` / `rename_replacement`), no aliases, no global state — the live
#      indices are never touched; `wait_for_completion=true`, and any failed shard fails the drill;
#   3. the index lists match BOTH ways: every live concrete index matching $OS_DRILL_INDICES is
#      in the snapshot, and every restored index still exists live as a concrete index (not an
#      alias, not renamed). Per index: `_count` of the copy against `_count` of the live index;
#      the snapshot is older than live, so up to $OS_DRILL_MAX_DRIFT_PCT percent is allowed; an
#      empty copy of a non-empty live index fails;
#   4. the temporary indices are deleted by exact name (never a wildcard).
# Writes $RESULTS_DIR/opensearch.json.
set -u
. "${OS_LIB:-/opt/soa/lib/os-curl.sh}"
: "${OS_DRILL_REPO:?}" "${RESULTS_DIR:?}"
PFX=${OS_DRILL_PREFIX:-drill-}
INDICES=${OS_DRILL_INDICES:-*,-.*}
DRIFT=${OS_DRILL_MAX_DRIFT_PCT:-10}
OUT="$RESULTS_DIR/opensearch.json"
MAX_AGE_H=${OS_DRILL_MAX_AGE_HOURS:-26}
# A snapshot that ENDS in the future (beyond this clock slack) is refused, never taken as fresh.
CLOCK_SLACK_S=${DRILL_CLOCK_SLACK_SECONDS:-3600}
mkdir -p "$RESULTS_DIR" || { echo "FATAL: cannot create $RESULTS_DIR"; exit 1; }
case $PFX in drill-*) ;; *) echo "FATAL: OS_DRILL_PREFIX must start with drill-"; exit 1 ;; esac
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\t' '  '; }
ITEMS=""
BASE_PFX=$PFX
cleanup() { # every drill copy, this run's and any interrupted run's — by exact name
  for i in $(os_curl GET "/_cat/indices/${BASE_PFX}*?h=index&expand_wildcards=all" 2>/dev/null); do
    case $i in "$BASE_PFX"*) os_curl DELETE "/$i" >/dev/null 2>&1 ;; esac
  done
}
result() { # result STATUS REASON
  cleanup
  printf '{"check":"opensearch","status":"%s","reason":"%s","at":"%s","snapshot":"%s","indices":[%s]}\n' \
    "$1" "$(esc "$2")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${SNAP:-}" "$ITEMS" > "$OUT"
  printf '{"ts":"%s","event":"restore-drill","status":"%s","check":"opensearch","reason":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$(esc "$2")"
  exit 0
}
count_of() { _c=$(os_curl GET "/$1/_count"); [ "$(os_status)" = 200 ] || return 1; printf '%s' "$_c" | sed -n 's/.*"count":\([0-9][0-9]*\).*/\1/p'; }

os_wait_ready "${OS_WAIT_TRIES:-30}" >/dev/null || result fail "OpenSearch not ready"
cleanup
PFX="${PFX}$(date -u +%Y%m%d%H%M%S)-"
SNAP=$(os_curl GET "/_cat/snapshots/$OS_DRILL_REPO?h=id,status,end_epoch&s=end_epoch")
[ "$(os_status)" = 200 ] || result fail "cannot list snapshots of '$OS_DRILL_REPO' (HTTP $(os_status)): $(printf '%s' "$SNAP" | head -c 200)"
LINE=$(printf '%s\n' "$SNAP" | awk '$2=="SUCCESS"{l=$0} END{print l}')
SNAP=$(printf '%s' "$LINE" | awk '{print $1}'); END_EPOCH=$(printf '%s' "$LINE" | awk '{print $3}')
[ -n "$SNAP" ] || result fail "repository '$OS_DRILL_REPO' has no successful snapshot"
case "${END_EPOCH:-}" in ''|*[!0-9]*) result fail "the newest snapshot $SNAP has no readable end time ('${END_EPOCH:-}')";; esac
age_s=$(( $(date -u +%s) - END_EPOCH ))
[ "$age_s" -ge "$(( 0 - CLOCK_SLACK_S ))" ] || result fail "the newest snapshot $SNAP ends $(( -age_s / 60 )) min in the future, beyond the ${CLOCK_SLACK_S} s clock slack: its time is wrong"
age_h=$(( age_s / 3600 ))
[ "$age_h" -le "$MAX_AGE_H" ] || result fail "the newest snapshot $SNAP is ${age_h} h old, above the ${MAX_AGE_H} h limit: snapshots have stopped"

BODY=$(printf '{"indices":"%s","ignore_unavailable":true,"include_global_state":false,"include_aliases":false,"rename_pattern":"(.+)","rename_replacement":"%s$1"}' "$INDICES" "$PFX")
R=$(os_curl POST "/_snapshot/$OS_DRILL_REPO/$SNAP/_restore?wait_for_completion=true" "$BODY")
[ "$(os_status)" = 200 ] || result fail "restore of $SNAP refused (HTTP $(os_status)): $(printf '%s' "$R" | head -c 300)"
failed=$(printf '%s' "$R" | sed -n 's/.*"shards":{[^}]*"failed":\([0-9][0-9]*\).*/\1/p')
total=$(printf '%s' "$R" | sed -n 's/.*"shards":{"total":\([0-9][0-9]*\).*/\1/p')
[ "${failed:-x}" = 0 ] && [ "${total:-0}" -gt 0 ] || result fail "restore of $SNAP: ${failed:-?} of ${total:-?} shard(s) failed: $(printf '%s' "$R" | head -c 300)"
os_curl GET "/_cluster/health/${PFX}*?wait_for_status=yellow&timeout=120s" >/dev/null

fails=0; n=0
# Both ways: every live CONCRETE index under the pattern must have been restored.
for li in $(os_curl GET "/_cat/indices/$INDICES?h=index&s=index"); do
  case $li in "$BASE_PFX"*|.*) continue ;; esac
  if ! os_curl GET "/_cat/indices/$PFX$li?h=index" >/dev/null || [ "$(os_status)" != 200 ]; then
    fails=$((fails+1)); n=$((n+1))
    [ -z "$ITEMS" ] || ITEMS="$ITEMS,"
    ITEMS="$ITEMS{\"index\":\"$(esc "$li")\",\"status\":\"fail\",\"restored\":null,\"live\":null,\"reason\":\"live index missing from snapshot $SNAP\"}"
  fi
done
for idx in $(os_curl GET "/_cat/indices/${PFX}*?h=index&s=index"); do
  orig=${idx#"$PFX"}; n=$((n+1))
  got=$(count_of "$idx") || got=""
  live=$(count_of "$orig") || live=""
  concrete=$(os_curl GET "/_cat/indices/$orig?h=index" 2>/dev/null | tr -d ' \n')
  st=pass; why=""
  if [ -z "$got" ]; then st=fail; why="restored index unreadable"
  elif [ -z "$live" ]; then st=fail; why="live index '$orig' not found"
  elif [ "$concrete" != "$orig" ]; then st=fail; why="'$orig' is no longer a concrete live index (renamed; the name now resolves to '$concrete')"
  elif [ "$live" -gt 0 ] && [ "$got" -eq 0 ]; then st=fail; why="restored copy is empty, live has $live"
  else
    d=$(( got > live ? got - live : live - got )); base=$(( live > 0 ? live : 1 ))
    if [ $(( d * 100 )) -gt $(( DRIFT * base )) ]; then st=fail; why="restored $got vs live $live: drift above ${DRIFT}%"
    else why="restored $got, live $live"; fi
  fi
  [ "$st" = pass ] || fails=$((fails+1))
  [ -z "$ITEMS" ] || ITEMS="$ITEMS,"
  ITEMS="$ITEMS{\"index\":\"$(esc "$orig")\",\"status\":\"$st\",\"restored\":${got:-null},\"live\":${live:-null},\"reason\":\"$(esc "$why")\"}"
done
[ "$n" -gt 0 ] || result fail "snapshot $SNAP restored no index matching '$INDICES'"
if [ "$fails" -eq 0 ]; then result pass "$n index(es) of $SNAP restored under a temporary prefix and counted"
else result fail "$fails of $n index(es) failed the document-count check"; fi
