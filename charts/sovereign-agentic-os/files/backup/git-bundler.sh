#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# The `git-backup` sidecar on the os-ui pod (WP-56). It mounts the repositories READ-ONLY and
# never takes part in a commit: os-ui drops a marker into the shared queue directory after a
# successful commit or push (core/infra/git-backup.ts) and returns at once; this loop picks the
# marker up and bundles that repository. INTERIM for the pg-boss outbox (WP-07's adapter is
# merged, but no process runs a queue yet — WP-08): a directory of marker files, one per repo.
#
# Three duties, one process (sequential, so one repository is never bundled twice at once):
#   - every $POLL_SECONDS:        bundle each queued repository           (git-bundle.sh)
#   - every $RESCAN_SECONDS:      bundle EVERY repository whose refs moved — the reconciler that
#                                 covers a lost marker (the queue is an emptyDir) and a restart
#   - every $REFS_RECORD_SECONDS: write the hash-chained ref-heads record (git-refs-record.sh)
# Status for Monitoring goes to $STATUS_FILE (read by os-ui from the shared volume).
set -u
. "${BACKUP_LIB:-/opt/soa/backup/lib.sh}"
D=$(dirname "$0")
REPOS=${REPOS_DIR:-/repos}
QUEUE=${QUEUE_DIR:-/backup-queue/queue}
STATUS_FILE=${STATUS_FILE:-/backup-queue/status.json}
POLL=${POLL_SECONDS:-5}; RESCAN=${RESCAN_SECONDS:-600}; RECORD=${REFS_RECORD_SECONDS:-3600}
mkdir -p "$QUEUE"
[ -s "$STATUS_FILE" ] || jq -n '{repos:{}}' > "$STATUS_FILE"

# Every bare repository under $REPOS (any depth up to 4), as "<gitdir> <key>".
list_repos() {
  find "$REPOS" -mindepth 1 -maxdepth 4 -type d -name '*.git' -prune 2>/dev/null | LC_ALL=C sort | while read -r g; do
    [ -f "$g/HEAD" ] || continue
    k=${g#"$REPOS"/}; k=${k%.git}
    valid_repo_key "$k" && printf '%s %s\n' "$g" "$k"
  done
}

status_set() { # status_set KEY OK|ERROR LOGLINE
  _tmp="$STATUS_FILE.tmp"
  jq --arg k "$1" --arg s "$2" --arg at "$(now_iso)" --argjson line "${3:-null}" \
    '.updatedAt=$at | .repos[$k] = ((.repos[$k] // {}) + {status:$s, at:$at, last:$line})
     | if $s=="ok" then .repos[$k].lastOkAt=$at else . end' "$STATUS_FILE" > "$_tmp" && mv "$_tmp" "$STATUS_FILE"
}

bundle() { # bundle GITDIR KEY
  out=$(sh "$D/git-bundle.sh" "$1" "$2" 2>&1); rc=$?
  printf '%s\n' "$out"
  line=$(printf '%s\n' "$out" | tail -n1); printf '%s' "$line" | jq -e . >/dev/null 2>&1 || line=$(jq -cn --arg m "$line" '{message:$m}')
  if [ $rc -eq 0 ]; then status_set "$2" ok "$line"; else status_set "$2" error "$line"; fi
}

last_rescan=0; last_record=0
log git-backup start repos "$REPOS" queue "$QUEUE" bucket "$S3_BUCKET"
while :; do
  now=$(date +%s)
  if [ $((now - last_rescan)) -ge "$RESCAN" ]; then
    rm -f "$QUEUE"/* 2>/dev/null   # a full pass covers every pending marker
    list_repos | while read -r g k; do bundle "$g" "$k"; done
    jq --arg at "$(now_iso)" '.lastRescanAt=$at' "$STATUS_FILE" > "$STATUS_FILE.tmp" && mv "$STATUS_FILE.tmp" "$STATUS_FILE"
    last_rescan=$now
  else
    for m in "$QUEUE"/*; do
      [ -f "$m" ] || continue
      k=$(cat "$m" 2>/dev/null); rm -f "$m"
      valid_repo_key "$k" && [ -f "$REPOS/$k.git/HEAD" ] && bundle "$REPOS/$k.git" "$k"
    done
  fi
  if [ $((now - last_record)) -ge "$RECORD" ]; then
    if out=$(sh "$D/git-refs-record.sh" 2>&1); then
      printf '%s\n' "$out"
      jq --arg at "$(now_iso)" '.lastRefsRecordAt=$at | .refsRecordError=null' "$STATUS_FILE" > "$STATUS_FILE.tmp" && mv "$STATUS_FILE.tmp" "$STATUS_FILE"
    else
      printf '%s\n' "$out"
      jq --arg e "$(printf '%s' "$out" | tail -n1)" '.refsRecordError=$e' "$STATUS_FILE" > "$STATUS_FILE.tmp" && mv "$STATUS_FILE.tmp" "$STATUS_FILE"
    fi
    last_record=$now
  fi
  [ -n "${BUNDLER_ONCE:-}" ] && exit 0
  sleep "$POLL"
done
