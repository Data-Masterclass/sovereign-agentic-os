#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Bundle ONE bare repository to object storage (WP-56). Upstream: git-bundle(1),
# https://git-scm.com/docs/git-bundle — isomorphic-git (the OS's writer) has no bundle support,
# so git's own CLI does it, from the backup-tools image.
#
#   git-bundle.sh <gitdir> <repo-key>
#
# Layout in $S3_BUCKET:
#   $BUNDLE_PREFIX/<repo>/<UTC-stamp>-<head12>.bundle   the bundle (git's own format)
#   $BUNDLE_PREFIX/<repo>/<UTC-stamp>-<head12>.json     its manifest (sha256, refs, chain)
#   $BUNDLE_PREFIX/<repo>/latest                        the pointer: a copy of the newest manifest
#
# The FIRST bundle of each UTC day is FULL (`--all`); later ones are INCREMENTAL against every
# tip of the previous bundle (`--all --not <tips>`), so a restore needs only today's chain.
# An incremental bundle omits refs whose tip did not move (git's own behaviour), so the
# manifest records the COMPLETE ref list; a restore sets exactly those refs.
#
# Every bundle is checked with `git bundle verify` against the live repository BEFORE upload,
# and its sha256 goes into the manifest, so a drill detects a corrupted or swapped object.
# Exit: 0 bundled or nothing to do; 1 failure (logged, nothing half-written becomes `latest`).
set -eu
. "${BACKUP_LIB:-/opt/soa/backup/lib.sh}"
GITDIR=$1; REPO=$2
PREFIX=${BUNDLE_PREFIX:-git-bundles}
WORK=${BACKUP_WORK:-/tmp}/bundle.$$
valid_repo_key "$REPO" || { log git-bundle error repo "$REPO" reason "invalid repository key"; exit 1; }
mkdir -p "$WORK"; trap 'rm -rf "$WORK"' EXIT
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'

refs_of "$GITDIR" > "$WORK/refs"
if [ ! -s "$WORK/refs" ]; then log git-bundle skip repo "$REPO" reason "no commits yet"; exit 0; fi
# TEMP-SPACE CAP. The bundle is staged in $BACKUP_WORK, an emptyDir with a sizeLimit; exceeding
# that limit evicts the WHOLE os-ui pod. So a repository bigger than the budget is refused (a
# red status, never an eviction), and `ulimit -f` makes any write past the budget fail at once.
BUDGET_MB=${BUNDLE_TMP_BUDGET_MB:-768}
need_kb=$(du -sk "$GITDIR" | cut -f1)
free_kb=$(df -Pk "$WORK" | awk 'NR==2 {print $4}')
if [ "$need_kb" -gt $((BUDGET_MB * 1024)) ] || [ "$need_kb" -gt "${free_kb:-0}" ]; then
  log git-bundle error repo "$REPO" reason "repository is $((need_kb / 1024)) MiB: above the bundle temp budget (${BUDGET_MB} MiB) or the free temp space ($(( ${free_kb:-0} / 1024 )) MiB); raise backup.gitBundles.tmpBudgetMi and its sizeLimit"
  exit 1
fi
ulimit -f $((BUDGET_MB * 2048)) || { log git-bundle error repo "$REPO" reason "cannot set the file-size limit"; exit 1; }
HEAD=$(git --git-dir="$GITDIR" rev-parse --verify -q refs/heads/main || head -n1 "$WORK/refs" | cut -d' ' -f1)
TODAY=$(date -u +%Y-%m-%d)

TYPE=full; CHAIN='[]'
if get_file "$PREFIX/$REPO/latest" "$WORK/prev.json"; then
  if jq -e --arg d "$TODAY" '.fullDay == $d' "$WORK/prev.json" >/dev/null; then
    TYPE=incremental; CHAIN=$(jq -c '.chain' "$WORK/prev.json")
  fi
  # Nothing moved since the last bundle → nothing to do (not an error, not a new object).
  if [ "$(jq -r '.refs | to_entries | map("\(.value) \(.key)") | .[]' "$WORK/prev.json" | LC_ALL=C sort)" = "$(cat "$WORK/refs")" ]; then
    log git-bundle unchanged repo "$REPO" head "$HEAD"; exit 0
  fi
fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BASE="$PREFIX/$REPO/$STAMP-$(printf '%.12s' "$HEAD")"
if [ "$TYPE" = full ]; then
  git --git-dir="$GITDIR" bundle create "$WORK/b.bundle" --all 2>"$WORK/err" || { log git-bundle error repo "$REPO" reason "$(cat "$WORK/err")"; exit 1; }
else
  # Prerequisites = the previous bundle's tips that still exist here (a pruned, force-pushed-away
  # tip is simply not a prerequisite; the chain already holds it).
  jq -r '.refs[]' "$WORK/prev.json" | sort -u | while read -r sha; do
    if git --git-dir="$GITDIR" cat-file -e "$sha^{commit}" 2>/dev/null; then printf '^%s\n' "$sha"; fi
  done > "$WORK/not"
  # shellcheck disable=SC2046
  if ! git --git-dir="$GITDIR" bundle create "$WORK/b.bundle" --all $(cat "$WORK/not") 2>"$WORK/err"; then
    if grep -q 'empty bundle' "$WORK/err"; then
      # Only refs were deleted or moved back onto known commits: no new objects. A FULL bundle
      # keeps the chain's ref list honest without inventing an empty one.
      TYPE=full; CHAIN='[]'
      git --git-dir="$GITDIR" bundle create "$WORK/b.bundle" --all 2>"$WORK/err" || { log git-bundle error repo "$REPO" reason "$(cat "$WORK/err")"; exit 1; }
    else
      log git-bundle error repo "$REPO" reason "$(cat "$WORK/err")"; exit 1
    fi
  fi
fi

# Verify with git itself (prerequisites resolve against the live repository).
git --git-dir="$GITDIR" bundle verify -q "$WORK/b.bundle" 2>"$WORK/err" || { log git-bundle error repo "$REPO" reason "bundle verify failed: $(cat "$WORK/err")"; exit 1; }

SHA=$(sha256_of "$WORK/b.bundle"); SIZE=$(wc -c < "$WORK/b.bundle" | tr -d ' ')
[ "$TYPE" = full ] && FULLDAY=$TODAY || FULLDAY=$(jq -r '.fullDay' "$WORK/prev.json")
refs_json < "$WORK/refs" > "$WORK/refs.json"
jq -n --arg repo "$REPO" --arg key "$BASE.bundle" --arg type "$TYPE" --arg sha "$SHA" --argjson size "$SIZE" \
  --arg head "$HEAD" --arg at "$(now_iso)" --arg fullDay "$FULLDAY" --argjson chain "$CHAIN" \
  --slurpfile refs "$WORK/refs.json" \
  '{repo:$repo, key:$key, type:$type, sha256:$sha, size:$size, head:$head, createdAt:$at, fullDay:$fullDay,
    refs:$refs[0], chain:($chain + [{key:$key, type:$type, sha256:$sha}])}' > "$WORK/manifest.json"

# Order matters: bundle, then its manifest, then the pointer. A failure before the pointer
# leaves the previous `latest` intact and the chain consistent.
put_file "$BASE.bundle" "$WORK/b.bundle" application/x-git-bundle
put_file "$BASE.json" "$WORK/manifest.json" application/json
put_file "$PREFIX/$REPO/latest" "$WORK/manifest.json" application/json
log git-bundle ok repo "$REPO" type "$TYPE" key "$BASE.bundle" head "$HEAD" sha256 "$SHA" chain "$(jq -r '.chain|length' "$WORK/manifest.json")"
