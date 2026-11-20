#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# dev-digest.sh — the os-ui digest that dev TESTED for a commit, from the dev run's own record.
# =============================================================================
#   bash scripts/lib/dev-digest.sh --sha <sha>        -> prints sha256:<...>
#
# WHY. The tag main-<sha> is mutable: a later build (a dispatch, a re-run) can point it at other
# bytes. What reached dev is recorded once, by the dev run that deployed it: the `dev-green` job
# of .github/workflows/dev.yml uploads the artifact `dev-tested-digest` ({sha, digest, image,
# run_id}) only after the deploy, the smoke test and the acceptance stage passed, and only when
# the digest RUNNING on dev equals the digest the image job built. An artifact belongs to its
# run and cannot be rewritten in place. This script reads it from the NEWEST push run of dev.yml
# on main for <sha> (the same run workflow-status.sh judged green) and prints its digest.
#
# Exit 0 + the digest; exit 1 + `NO_DEV_DIGEST_RECORD: <why>` (no run, no artifact, a record for
# another commit, a malformed digest); exit 2 on a usage error. Prints no token.
set -euo pipefail
REPO=${WORKFLOW_REPO:-${GITHUB_REPOSITORY:-Data-Masterclass/sovereign-agentic-os}}
SHA=''
while [ $# -gt 0 ]; do
  case $1 in
    --sha) SHA=${2:-}; shift ;;
    *) echo "dev-digest.sh: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$SHA" ] || { echo "usage: dev-digest.sh --sha <sha>" >&2; exit 2; }
none() { echo "NO_DEV_DIGEST_RECORD: $*"; exit 1; }

runs=$(gh api "repos/$REPO/actions/runs?head_sha=$SHA&event=push&branch=main&per_page=100" \
  --jq '.workflow_runs | sort_by(.created_at) | reverse | .[]
        | [(.path | split("/") | last), .status, (.conclusion // "none"), .html_url, (.id | tostring)] | @tsv') \
  || none "the GitHub API could not be read"
run_id=$(printf '%s\n' "$runs" | awk -F'\t' '$1 == "dev.yml" { print $5; exit }')
[ -n "$run_id" ] || none "no dev.yml run on main for ${SHA:0:12}"

dir=$(mktemp -d); trap 'rm -rf "$dir"' EXIT
gh run download "$run_id" --repo "$REPO" -n dev-tested-digest -D "$dir" >/dev/null 2>&1 \
  || none "dev.yml run $run_id has no dev-tested-digest artifact (dev-green did not record one)"
[ -f "$dir/dev-tested-digest.json" ] || none "the artifact of run $run_id holds no dev-tested-digest.json"
python3 - "$dir/dev-tested-digest.json" "$SHA" "$run_id" <<'PY' || exit 1
import json, re, sys
r = json.load(open(sys.argv[1]))
sha, run = sys.argv[2], sys.argv[3]
if r.get("sha") != sha:
    print(f"NO_DEV_DIGEST_RECORD: the record of run {run} is for {str(r.get('sha'))[:12]}, not {sha[:12]}"); sys.exit(1)
if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(r.get("digest", ""))):
    print(f"NO_DEV_DIGEST_RECORD: the record of run {run} has no valid digest"); sys.exit(1)
print(r["digest"])
PY
