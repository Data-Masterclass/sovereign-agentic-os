#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Delete the indices left behind by components the OS no longer runs (WP-21, design 02 step 1).
# Run by the `opensearch-orphan-cleanup` Job on install/upgrade and by `tests/opensearch`.
#
# EXACTLY these, matched as whole names (anchored), nothing else:
#   OpenMetadata reindex leftovers   ^[a-z0-9_]+_search_index_rebuild_[0-9]{13}$   DELETE /<index>
#   OpenMetadata data streams        ^di-data-assets-[a-z0-9]+$                     DELETE /_data_stream/<name>
#                                    (removes the backing .ds-di-data-assets-*-NNNNNN indices)
#   Haystack (removed component)     ^haystack_knowledge$                          DELETE /<index>
# Live on 2026-11-20 that is 55 + 16 backing indices + 1 = 72. Names are deleted one by one;
# no wildcard is ever sent to a DELETE.
#
# Order: list -> nothing matched? exit 0 (idempotent, a re-run is a no-op) -> more than
# $OS_CLEANUP_MAX_DELETE matched? refuse (something unexpected is there) -> snapshot everything
# to $OS_CLEANUP_SNAPSHOT_REPO and require SUCCESS -> delete. Without a repository the Job
# refuses to delete: rollback is "restore from that snapshot".
set -eu
. "${OS_LIB:-/opt/soa/lib/os-curl.sh}"
MAX=${OS_CLEANUP_MAX_DELETE:-72}
REPO=${OS_CLEANUP_SNAPSHOT_REPO:-}
DRY=${OS_CLEANUP_DRY_RUN:-false}

INDEX_RE='^([a-z0-9_]+_search_index_rebuild_[0-9]{13}|haystack_knowledge)$'
STREAM_RE='^di-data-assets-[a-z0-9]+$'

os_wait_ready "${OS_WAIT_TRIES:-60}"

# Indices (open and closed, hidden excluded: data-stream backing indices are handled as streams).
names=$(os_curl GET '/_cat/indices?h=index&expand_wildcards=open,closed')
[ "$(os_status)" = 200 ] || { echo "FATAL: _cat/indices HTTP $(os_status)"; exit 1; }
indices=$(printf '%s\n' "$names" | tr -d ' \r' | grep -E "$INDEX_RE" || true)

streams_json=$(os_curl GET '/_data_stream')
[ "$(os_status)" = 200 ] || { echo "FATAL: _data_stream HTTP $(os_status)"; exit 1; }
streams=$(printf '%s' "$streams_json" | grep -o '"name":"[^"]*"' | sed 's/"name":"\(.*\)"/\1/' | grep -E "$STREAM_RE" || true)

# Count the backing indices each matched stream carries (what the 72 refers to).
backing=0
for s in $streams; do
  n=$(os_curl GET "/_data_stream/$s" | grep -o '"index_name":"[^"]*"' | wc -l | tr -d ' ')
  backing=$((backing + n))
done
n_idx=$(printf '%s\n' "$indices" | grep -c . || true)
n_str=$(printf '%s\n' "$streams" | grep -c . || true)
total=$((n_idx + backing))

echo "Matched: $n_idx indices, $n_str data streams ($backing backing indices) = $total indices."
printf '%s\n' "$indices" "$streams" | grep . | sed 's/^/  - /' || true
if [ "$total" -eq 0 ] && [ "$n_str" -eq 0 ]; then
  echo "Nothing to delete — cleanup already done."
  exit 0
fi
if [ "$total" -gt "$MAX" ]; then
  echo "FATAL: $total indices match, more than the documented $MAX. Refusing; inspect and raise opensearchCleanup.maxDelete only if every one is an orphan."
  exit 1
fi
if [ "$DRY" = true ]; then echo "Dry run: nothing deleted."; exit 0; fi

[ -n "$REPO" ] || { echo "FATAL: no snapshot repository configured (opensearchCleanup.snapshotRepository); refusing to delete without a snapshot."; exit 1; }
SNAP="pre-orphan-cleanup-$(date -u +%Y%m%d-%H%M%S)"
echo "Snapshot '$SNAP' of all indices to '$REPO' before deleting ..."
# Started asynchronously and polled: a full snapshot to object storage can outlast one HTTP
# request. A snapshot already running (e.g. the nightly SM one) is waited out, then retried.
body='{"indices":"*","ignore_unavailable":true,"include_global_state":false}'
deadline=$(( $(date +%s) + ${OS_CLEANUP_SNAPSHOT_TIMEOUT_S:-3600} ))
while :; do
  out=$(os_curl PUT "/_snapshot/$REPO/$SNAP" "$body")
  [ "$(os_status)" = 200 ] && break
  printf '%s' "$out" | grep -q 'concurrent_snapshot_execution_exception' \
    || { echo "FATAL: snapshot not started (HTTP $(os_status)): $out"; exit 1; }
  [ "$(date +%s)" -lt "$deadline" ] || { echo "FATAL: another snapshot kept running past the deadline"; exit 1; }
  echo "Another snapshot is running; retrying in 10 s ..."; sleep 10
done
state=
while [ "$(date +%s)" -lt "$deadline" ]; do
  out=$(os_curl GET "/_snapshot/$REPO/$SNAP")
  state=$(printf '%s' "$out" | sed -n 's/.*"state":"\([A-Z_]*\)".*/\1/p')
  case $state in
    SUCCESS) break ;;
    FAILED|PARTIAL|INCOMPATIBLE) echo "FATAL: snapshot '$SNAP' ended $state: $out"; exit 1 ;;
  esac
  sleep 5
done
[ "$state" = SUCCESS ] || { echo "FATAL: snapshot '$SNAP' not SUCCESS before the deadline (state: ${state:-unknown})"; exit 1; }
echo "Snapshot '$SNAP' SUCCESS (restore it to roll back)."

for i in $indices; do
  os_curl DELETE "/$i" >/dev/null
  case $(os_status) in 200|404) echo "deleted index $i" ;; *) echo "FATAL: DELETE /$i HTTP $(os_status)"; exit 1 ;; esac
done
for s in $streams; do
  os_curl DELETE "/_data_stream/$s" >/dev/null
  case $(os_status) in 200|404) echo "deleted data stream $s" ;; *) echo "FATAL: DELETE /_data_stream/$s HTTP $(os_status)"; exit 1 ;; esac
done
echo "Cleanup complete: $total indices removed."
