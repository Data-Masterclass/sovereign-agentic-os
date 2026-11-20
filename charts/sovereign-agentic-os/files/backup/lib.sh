# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Shared helpers for the WP-56 backup and restore-drill scripts (git bundles, drills, reports).
# Sourced, never executed. Needs: aws (aws-cli v2), jq, git, openssl — the backup-tools image.
#
#   S3_ENDPOINT   S3 API endpoint (https://object.storage.eu01.onstackit.cloud, http://minio:9000)
#   S3_BUCKET     the bucket (created by the owner, Object Lock on — docs/backups.md)
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION   from the Secret
#
# Every log line is ONE JSON object on stdout, so the cluster's log pipeline can match
# `"event":"git-bundle"` or `"event":"restore-drill"` without parsing prose.

: "${S3_ENDPOINT:?S3_ENDPOINT is not set}" "${S3_BUCKET:?S3_BUCKET is not set}"

# aws-cli >= 2.23 sends CRC checksums on every PUT by default; S3-compatible stores differ in
# what they accept, so send a checksum only where the API requires one (we send Content-MD5
# ourselves — an Object Lock bucket REQUIRES an integrity header on PutObject).
export AWS_REQUEST_CHECKSUM_CALCULATION=${AWS_REQUEST_CHECKSUM_CALCULATION:-when_required}
export AWS_RESPONSE_CHECKSUM_VALIDATION=${AWS_RESPONSE_CHECKSUM_VALIDATION:-when_required}
export AWS_EC2_METADATA_DISABLED=true
export AWS_PAGER=""

s3api() { aws --endpoint-url "$S3_ENDPOINT" s3api "$@"; }

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# log EVENT STATUS [key value]...  → {"ts":…,"event":…,"status":…,"key":"value",…}
log() {
  _e=$1; _s=$2; shift 2
  _n=$#; _i=0
  while [ "$_i" -lt "$_n" ]; do set -- "$@" --arg "$1" "${2-}"; shift 2; _i=$((_i + 2)); done
  jq -cn --arg ts "$(now_iso)" --arg event "$_e" --arg status "$_s" "$@" '$ARGS.named'
}

sha256_of() { openssl dgst -sha256 -r "$1" | cut -d' ' -f1; }
md5_b64_of() { openssl dgst -md5 -binary "$1" | openssl base64 -A; }

# put_file KEY FILE [CONTENT_TYPE] — PutObject with Content-MD5 (Object Lock needs it). When
# OBJECT_LOCK_MODE and OBJECT_LOCK_DAYS are set, the object also carries an explicit retention
# (otherwise the bucket's default retention applies, which is the recommended setup).
put_file() {
  _k=$1; _f=$2; _ct=${3:-application/octet-stream}
  set -- --bucket "$S3_BUCKET" --key "$_k" --body "$_f" --content-md5 "$(md5_b64_of "$_f")" --content-type "$_ct"
  if [ -n "${OBJECT_LOCK_MODE:-}" ] && [ "${OBJECT_LOCK_DAYS:-0}" -gt 0 ]; then
    _until=$(date -u -d "@$(( $(date -u +%s) + OBJECT_LOCK_DAYS * 86400 ))" +%Y-%m-%dT%H:%M:%SZ)
    set -- "$@" --object-lock-mode "$OBJECT_LOCK_MODE" --object-lock-retain-until-date "$_until"
  fi
  s3api put-object "$@" >/dev/null
}

# get_file KEY FILE — returns non-zero (and leaves no file) when the object is absent.
get_file() {
  rm -f "$2"
  s3api get-object --bucket "$S3_BUCKET" --key "$1" "$2" >/dev/null 2>"$2.err" || { rm -f "$2"; return 1; }
  rm -f "$2.err"
}

# A repository key is the bare repo's path under the repos root without `.git`
# (`sales`, or a nested `users/alex` once repo-layout adds kinds). Refuse anything else.
valid_repo_key() {
  case $1 in
    ''|/*|*..*|*//*|*/) return 1 ;;
  esac
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
}

# Every ref of a repo, sorted, one "sha refname" per line (HEAD excluded: it is symbolic).
refs_of() { git --git-dir="$1" for-each-ref --format='%(objectname) %(refname)' | LC_ALL=C sort; }

# refs text → JSON object {"refs/heads/main":"sha",…}
refs_json() { jq -Rn '[inputs | select(length>0) | split(" ") | {(.[1]): .[0]}] | add // {}'; }
