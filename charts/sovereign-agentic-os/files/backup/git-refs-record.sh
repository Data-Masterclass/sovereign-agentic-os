#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Tamper evidence (WP-56 §4): record every repository's ref heads in the object-locked bucket.
# INTERIM until the audit anchor (WP-08) exists: one object per run,
#   $REFS_PREFIX/<YYYY>/<MM>/<DD>/<UTC-stamp>.json
# holding {at, repos:{<key>:{<ref>:<sha>}}, prev:{key, sha256}}. Each record names the sha256 of
# the one before it (hash chain), and Object Lock makes every record immutable for the
# retention period — so a rewritten history shows up as heads that no record ever saw, and a
# removed or edited record breaks the chain. `$REFS_PREFIX/latest` points at the newest record.
set -eu
. "${BACKUP_LIB:-/opt/soa/backup/lib.sh}"
REPOS=${REPOS_DIR:-/repos}; PREFIX=${REFS_PREFIX:-git-refs}
W=${BACKUP_WORK:-/tmp}/refs.$$; mkdir -p "$W"; trap 'rm -rf "$W"' EXIT
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'

echo '{}' > "$W/repos.json"
find "$REPOS" -mindepth 1 -maxdepth 4 -type d -name '*.git' -prune 2>/dev/null | LC_ALL=C sort | while read -r g; do
  [ -f "$g/HEAD" ] || continue
  k=${g#"$REPOS"/}; k=${k%.git}; valid_repo_key "$k" || continue
  refs_of "$g" | refs_json > "$W/one.json"
  jq --arg k "$k" --slurpfile r "$W/one.json" '.[$k]=$r[0]' "$W/repos.json" > "$W/t" && mv "$W/t" "$W/repos.json"
done
PREV=null
if get_file "$PREFIX/latest" "$W/prev.json"; then
  PREV=$(jq -c --arg sha "$(sha256_of "$W/prev.json")" '{key:.key, sha256:$sha}' "$W/prev.json")
fi
STAMP=$(date -u +%Y%m%dT%H%M%SZ); DAY=$(date -u +%Y/%m/%d)
KEY="$PREFIX/$DAY/$STAMP.json"
jq -n --arg at "$(now_iso)" --arg key "$KEY" --slurpfile r "$W/repos.json" --argjson prev "$PREV" \
  '{at:$at, key:$key, repos:$r[0], prev:$prev}' > "$W/rec.json"
put_file "$KEY" "$W/rec.json" application/json
put_file "$PREFIX/latest" "$W/rec.json" application/json
log git-refs-record ok key "$KEY" repos "$(jq -r '.repos|length' "$W/rec.json")" sha256 "$(sha256_of "$W/rec.json")"
