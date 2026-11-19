#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# registry-digest.sh — print the sha256 digest a registry tag resolves to.
# =============================================================================
#   bash scripts/lib/registry-digest.sh <host/path:tag>
#
# A helper, not a command: every caller runs it through `bash <path>`, so it needs no execute
# bit and is mode 644 like the rest of scripts/lib. The shebang is there to name the interpreter
# for a reader and for shellcheck.
#
# The LAST-RESORT probe behind `scripts/deploy.sh --from-registry`, used when neither `crane`
# nor `skopeo` is installed. Plain registry v2 over curl: fetch a pull token, HEAD the manifest,
# read `Docker-Content-Digest`.
#
# `docker manifest inspect` would be the obvious tool and is deliberately not used anywhere in
# this path: it needs the Docker daemon the --from-registry mode exists to avoid.
#
# Three things here are deliberate and were each a review finding:
#
#  - The HTTP STATUS is captured and classified (M4). Collapsing every failure into "no digest"
#    made an auth problem look like a missing tag: 401/403 means the token cannot read a PRIVATE
#    package (a `gh` token without `read:packages`), and the fix is a different one from 404's.
#  - Credentials go in on STDIN via `curl -K -` (L9), never in argv, where any process on the
#    machine can read them out of `ps`.
#  - Both calls carry `--max-time 30` (L8). A registry that hangs must not hang a deploy; the
#    caller still has the backup gate and the upgrade ahead of it.
#
# REGISTRY_CURL replaces the curl binary, which is what lets the shell test drive every status
# code without a network. Nothing in production sets it.
set -euo pipefail

REF=${1:?usage: registry-digest.sh <host/path:tag>}
CURL=${REGISTRY_CURL:-curl}

# host/path:tag — the path is everything between the first `/` and the `:`, which for ghcr.io is
# <owner>/<repo>/<image>.
host=${REF%%/*}
rest=${REF#*/}
path=${rest%:*}
tag=${rest##*:}
case $REF in
  */*:*) ;;
  *) echo "BAD_IMAGE_REFERENCE '$REF' — expected host/path:tag" >&2; exit 2 ;;
esac

# A pull token is required even for a public GHCR package. `gh auth token` is used when the CLI
# is logged in (a private package needs it); otherwise we ask anonymously. The token is written
# to curl's stdin config, never to argv.
cfg=
if command -v gh >/dev/null 2>&1; then
  tok=$(gh auth token 2>/dev/null || true)
  [ -n "${tok:-}" ] && cfg=$(printf 'user = "x:%s"\n' "$tok")
fi

body=$(mktemp)
hdrs=$(mktemp)
trap 'rm -f "$body" "$hdrs"' EXIT

# THE TOKEN LEG IS CLASSIFIED TOO (review L2). It used to be judged only by whether a token
# came back, so a DNS failure, a proxy, or a registry 500 on THIS call all reported
# "not authorised / the package is private" — sending the reader after a credential problem
# that did not exist. The status comes first; the body is only read on a 200.
tokcode=$(printf '%s' "$cfg" | "$CURL" -sS --max-time 30 -K - -o "$body" -w '%{http_code}' \
  "https://$host/token?service=$host&scope=repository:$path:pull" || true)

case ${tokcode:-000} in
  200) ;;
  000)
    echo "REGISTRY_UNREACHABLE — no answer from $host within 30s when asking for a pull token" >&2
    echo "   (DNS, a proxy, or no network — not a credential problem)." >&2
    exit 1 ;;
  401|403)
    if [ -z "$cfg" ]; then
      echo "REGISTRY_NOT_AUTHORISED — $host refused an ANONYMOUS pull token for $path ($tokcode)." >&2
      echo "   The package is private. Log in with 'gh auth login' (the token needs read:packages)," >&2
      echo "   or install crane ('brew install crane') which reads ~/.docker/config.json." >&2
    else
      echo "REGISTRY_NOT_AUTHORISED — $host refused a pull token for $path with the gh token ($tokcode)." >&2
      echo "   The token most likely lacks read:packages: 'gh auth refresh -s read:packages'." >&2
    fi
    exit 1 ;;
  5*)
    echo "REGISTRY_ERROR — $host answered $tokcode for a pull token on $path." >&2
    echo "   The registry is failing, not your credentials. Retry, or check its status page." >&2
    exit 1 ;;
  *)
    echo "REGISTRY_TOKEN_HTTP_$tokcode — unexpected status asking $host for a pull token on $path." >&2
    exit 1 ;;
esac

bearer=$(python3 -c 'import json,sys
try:
    print(json.load(open(sys.argv[1])).get("token") or "")
except Exception:
    print("")' "$body" 2>/dev/null || true)

if [ -z "$bearer" ]; then
  # 200 with no usable token: GHCR answers exactly this way (`{"errors":[{"code":"DENIED"}]}`)
  # for an anonymous request against a private package.
  echo "REGISTRY_NOT_AUTHORISED — $host answered 200 but issued no pull token for $path." >&2
  if [ -z "$cfg" ]; then
    echo "   That is how GHCR denies an anonymous request for a PRIVATE package." >&2
    echo "   Log in with 'gh auth login' (needs read:packages), or install crane." >&2
  else
    echo "   The gh token most likely lacks read:packages: 'gh auth refresh -s read:packages'." >&2
  fi
  exit 1
fi

# -I is HEAD. The Accept list covers both the OCI index and the v2 manifest media types, so a
# single-platform image and a manifest list both answer.
code=$(printf 'header = "Authorization: Bearer %s"\n' "$bearer" \
  | "$CURL" -sS --max-time 30 -K - -I -o /dev/null -D "$hdrs" -w '%{http_code}' \
      -H 'Accept: application/vnd.oci.image.index.v1+json' \
      -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
      -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
      -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
      "https://$host/v2/$path/manifests/$tag" || true)

digest=$(tr -d '\r' < "$hdrs" | awk 'tolower($1) == "docker-content-digest:" { print $2 }' | tail -1)

case ${code:-000} in
  200)
    [ -n "$digest" ] || { echo "REGISTRY_NO_DIGEST_HEADER — $host answered 200 for $path:$tag but sent no Docker-Content-Digest" >&2; exit 1; }
    printf '%s\n' "$digest"
    ;;
  401|403)
    echo "REGISTRY_NOT_AUTHORISED — $host answered $code for $path:$tag." >&2
    echo "   Not authorised for a private package: the gh token lacks read:packages." >&2
    echo "   Fix with 'gh auth refresh -s read:packages', or install crane / skopeo." >&2
    exit 1
    ;;
  404)
    echo "REGISTRY_TAG_NOT_FOUND — $host has no $path:$tag (404). The tag was never pushed," >&2
    echo "   or it was pushed to a different namespace (check IMAGE_REPO)." >&2
    exit 1
    ;;
  000)
    echo "REGISTRY_UNREACHABLE — no answer from $host within 30s (DNS, proxy or network)." >&2
    exit 1
    ;;
  *)
    echo "REGISTRY_HTTP_$code — $host answered $code for $path:$tag." >&2
    exit 1
    ;;
esac
