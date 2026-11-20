#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Restore drill, git part (WP-56 §3). For EVERY repository — every one the live OS has and
# every one the bucket has a `latest` pointer for — restore the latest bundle chain into a
# temporary bare repository with git's own tools and prove it:
#   1. every bundle of the chain exists, matches the sha256 in its manifest and passes
#      `git bundle verify` against what has been restored so far;
#   2. `git fetch <bundle>` applies it; the manifest's complete ref list is set with
#      `git update-ref` (which refuses a ref whose object is missing);
#   3. `git fsck --full` passes;
#   4. every restored ref equals the live ref. A live repository may be a commit ahead while
#      the drill runs: the comparison is retried with the NEWEST pointer ($DRILL_LAG_RETRIES x
#      $DRILL_LAG_SLEEP s) before it is called a failure.
# Writes $RESULTS_DIR/git.json (the directory is created here). A pass needs EXACTLY the live
# inventory proven: every live repository with commits restored and equal, nothing else in the
# bucket, no invalid key, at least one repository. Anything less is a failure.
#
#   LIVE_INVENTORY_URL  os-ui /api/git/backup-inventory (bearer $LIVE_INVENTORY_TOKEN); file:// in tests
set -u
. "${BACKUP_LIB:-/opt/soa/backup/lib.sh}"
PREFIX=${BUNDLE_PREFIX:-git-bundles}
OUT=${RESULTS_DIR:?}/git.json
mkdir -p "$RESULTS_DIR" || { echo "FATAL: cannot create $RESULTS_DIR"; exit 1; }
W=${BACKUP_WORK:-/tmp}/drill-git.$$; mkdir -p "$W"; trap 'rm -rf "$W"' EXIT
RETRIES=${DRILL_LAG_RETRIES:-3}; LAG_SLEEP=${DRILL_LAG_SLEEP:-20}
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'

finish() { # finish STATUS REASON — write the result from $W/repos.jsonl
  [ -f "$W/repos.jsonl" ] || : > "$W/repos.jsonl"
  jq -s --arg s "$1" --arg r "$2" --arg at "$(now_iso)" '{check:"git", status:$s, reason:$r, at:$at, repos:.}' "$W/repos.jsonl" > "$OUT"
  log restore-drill "$1" check git reason "$2" repos "$(jq -r '.repos|length' "$OUT")"
  exit 0
}

live_inventory() {
  set -- -sS -f --max-time 60 -o "$W/live.json"
  [ -n "${LIVE_INVENTORY_TOKEN:-}" ] && set -- "$@" -H "Authorization: Bearer $LIVE_INVENTORY_TOKEN"
  curl "$@" "${LIVE_INVENTORY_URL:?}" 2>"$W/live.err" && jq -e '.repos | type == "array"' "$W/live.json" >/dev/null 2>&1
}
live_refs() { jq -r --arg k "$1" '.repos[] | select(.key==$k) | .refs | to_entries[] | "\(.value) \(.key)"' "$W/live.json" | LC_ALL=C sort; }
rdir() { printf '%s/r/%s' "$W" "$(printf '%s' "$1" | tr '/' '_')"; }

# restore KEY -> 0 and <rdir>/restored.refs, or 1 with the reason in $W/reason
restore() {
  k=$1; R=$(rdir "$k"); rm -rf "$R"; mkdir -p "$R"
  get_file "$PREFIX/$k/latest" "$R/latest.json" || { echo "no latest pointer in the bucket" > "$W/reason"; return 1; }
  jq -e '.chain|length>0' "$R/latest.json" >/dev/null 2>&1 || { echo "latest pointer has no bundle chain" > "$W/reason"; return 1; }
  git init -q --bare "$R/repo.git"
  n=0
  for row in $(jq -r '.chain[] | "\(.key)|\(.sha256)"' "$R/latest.json"); do
    n=$((n+1)); key=${row%|*}; want=${row#*|}
    get_file "$key" "$R/$n.bundle" || { echo "bundle missing: $key" > "$W/reason"; return 1; }
    got=$(sha256_of "$R/$n.bundle")
    [ "$got" = "$want" ] || { echo "sha256 mismatch on $key (manifest $want, object $got)" > "$W/reason"; return 1; }
    git --git-dir="$R/repo.git" bundle verify -q "$R/$n.bundle" >/dev/null 2>"$R/err" || { echo "git bundle verify failed on $key: $(head -c 300 "$R/err")" > "$W/reason"; return 1; }
    git --git-dir="$R/repo.git" fetch -q --no-write-fetch-head "$R/$n.bundle" '+refs/*:refs/restore/*' 2>"$R/err" || { echo "git fetch from $key failed: $(head -c 300 "$R/err")" > "$W/reason"; return 1; }
    git --git-dir="$R/repo.git" for-each-ref --format='delete %(refname)' refs/restore/ | git --git-dir="$R/repo.git" update-ref --stdin
  done
  jq -r '.refs | to_entries[] | "\(.value) \(.key)"' "$R/latest.json" > "$R/manifest.refs"
  while read -r sha ref; do
    git --git-dir="$R/repo.git" update-ref "$ref" "$sha" 2>>"$R/err" || echo "x" >> "$R/bad"
  done < "$R/manifest.refs"
  [ ! -f "$R/bad" ] || { echo "a ref in the manifest points at an object no bundle carried: $(head -c 300 "$R/err")" > "$W/reason"; return 1; }
  git --git-dir="$R/repo.git" fsck --full --no-dangling >"$R/fsck" 2>&1 || { echo "git fsck --full failed: $(head -c 300 "$R/fsck")" > "$W/reason"; return 1; }
  refs_of "$R/repo.git" > "$R/restored.refs"
  echo "$n" > "$R/chainlen"
}

live_inventory || finish fail "live repository inventory unreadable: $(head -c 200 "$W/live.err" 2>/dev/null)"
s3api list-objects-v2 --bucket "$S3_BUCKET" --prefix "$PREFIX/" --query 'Contents[].Key' --output json > "$W/keys.json" 2>"$W/s3.err" \
  || finish fail "bucket listing failed: $(head -c 200 "$W/s3.err")"
{ jq -r '.[]? // empty' "$W/keys.json" | sed -n "s#^$PREFIX/\(.*\)/latest\$#\1#p"
  jq -r '.repos[] | select((.refs|length)>0) | .key' "$W/live.json"; } | LC_ALL=C sort -u > "$W/all"
[ -s "$W/all" ] || finish fail "no repository found, live or in the bucket - nothing was proven"

: > "$W/repos.jsonl"; fails=0
while read -r k; do
  if ! valid_repo_key "$k"; then
    fails=$((fails+1))
    jq -cn --arg repo "$k" '{repo:$repo, status:"fail", reason:"invalid repository key in the bucket (not a repo the OS can have)"}' >> "$W/repos.jsonl"
    log restore-drill fail check git repo "$k" reason "invalid repository key"
    continue
  fi
  # A repo-layout ALIAS (a symlink to another repo, after a rename) has old bundles under its
  # name: recognised and reported, neither a failure nor a proof.
  target=$(jq -r --arg k "$k" '[.aliases[]? | select(.key==$k) | .target][0] // empty' "$W/live.json")
  if [ -n "$target" ]; then
    jq -cn --arg repo "$k" --arg t "$target" '{repo:$repo, status:"alias", reason:("bundles from before a rename; the live repository is " + $t)}' >> "$W/repos.jsonl"
    continue
  fi
  inlive=$(jq -r --arg k "$k" 'any(.repos[]; .key==$k)' "$W/live.json")
  try=0; status=fail; reason=""
  while :; do
    if restore "$k"; then
      R=$(rdir "$k")
      if [ "$inlive" != true ]; then reason="restored, but the repository is not in the live OS (deleted, or the inventory is wrong)"; break; fi
      live_refs "$k" > "$W/live.refs"
      if cmp -s "$W/live.refs" "$R/restored.refs"; then
        status=pass; reason="chain of $(cat "$R/chainlen") bundle(s) restored; fsck clean; $(wc -l < "$R/restored.refs" | tr -d ' ') ref(s) equal live"; break
      fi
      reason="restored refs differ from live: $(diff "$R/restored.refs" "$W/live.refs" | grep '^[<>]' | head -n 4 | tr '\n' ';')"
    else
      reason=$(cat "$W/reason")
    fi
    try=$((try+1)); [ "$try" -gt "$RETRIES" ] && break
    sleep "$LAG_SLEEP"; live_inventory || { reason="live inventory unreadable on retry"; break; }
    inlive=$(jq -r --arg k "$k" 'any(.repos[]; .key==$k)' "$W/live.json")
  done
  [ "$status" = pass ] || fails=$((fails+1))
  jq -cn --arg repo "$k" --arg s "$status" --arg r "$reason" '{repo:$repo, status:$s, reason:$r}' >> "$W/repos.jsonl"
  log restore-drill "$status" check git repo "$k" reason "$reason"
done < "$W/all"

# Exact match: the set of repositories PROVEN equals the set of live repositories with commits.
jq -r '.repos[] | select((.refs|length)>0) | .key' "$W/live.json" | LC_ALL=C sort -u > "$W/live.keys"
jq -r 'select(.status=="pass") | .repo' "$W/repos.jsonl" | LC_ALL=C sort -u > "$W/proven.keys"
nlive=$(wc -l < "$W/live.keys" | tr -d ' '); nproven=$(wc -l < "$W/proven.keys" | tr -d ' ')
if [ "$nlive" -eq 0 ]; then finish fail "the live inventory has no repository with commits - nothing was proven"; fi
if ! cmp -s "$W/live.keys" "$W/proven.keys"; then
  finish fail "proved $nproven of $nlive live repositories (missing: $(comm -23 "$W/live.keys" "$W/proven.keys" | head -n 5 | tr '\n' ' '))"
fi
if [ "$fails" -eq 0 ]; then finish pass "$nproven of $nlive live repositories restored and equal to live"
else finish fail "$fails repository check(s) failed"; fi
