#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
#
# `git daemon --access-hook` (https://git-scm.com/docs/git-daemon#Documentation/git-daemon.txt---access-hookltpathgt):
# git runs this before serving a request, with  <service> <path> <hostname> <canonical-hostname> <ip> <port>,
# and refuses the request when it exits non-zero.
#
# The in-cluster git daemon has no client identity (the git protocol carries none), so it serves
# DOMAIN repositories only — what the Dagster repo-sync needs. A personal repository (`user-<token>`,
# readable by its owner and admins) and the `platform` repository (admins) are reachable only
# through the authenticated HTTP door. Component design 12: the repo boundary is the access boundary.
repo="$2"
real="$(readlink -f "$repo" 2>/dev/null || printf '%s' "$repo")"
for p in "$repo" "$real"; do
  name="$(basename "$p" .git)"
  case "$name" in
    user-*|platform)
      echo "this repository is not served over the in-cluster git protocol; use the authenticated https door"
      exit 1
      ;;
  esac
done
exit 0
