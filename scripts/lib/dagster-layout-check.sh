#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
#
# AREA:       deploy tooling (WP-49 on WP-55, review N1)
# FEATURE:    Read-only checks around a Dagster image change:
#               layout <ctx> <ns>    every live domain repo's layout and how the Dagster image will
#                                    wire it — NATIVE (migrated, its own data/dagster/definitions.py
#                                    matching os/generated.yml), LEGACY (not migrated, or no hash
#                                    record yet: os/schedules.yml as before), or REFUSED (a module
#                                    whose hash does not match: the domain would be skipped).
#                                    Exits 1 when any repo would be REFUSED.
#               schedules <ctx> <ns> the number of schedules the running Dagster location defines.
# USER STORY: As the operator I want a deploy to stop BEFORE a domain silently loses its schedules,
#             and to fail AFTER the rollout when the schedule count dropped.
# ARCHITECTURE:
#   - Read-only by construction: `git ls-tree` / `git show` on repo-sync's bare mirrors inside the
#     code-location pod, and one GraphQL READ on the webserver from inside its own pod (the
#     NetworkPolicy admits nothing else to :80). No exec writes, no port-forward, no secret read.
#   - The classification mirrors images/extensions/dagster/os_projects.py `native_definitions`:
#     marker os/layout.yml + data/dagster/definitions.py + an os/generated.yml record that equals the
#     file's sha256 ⇒ NATIVE; any of the three missing ⇒ LEGACY; a record that differs ⇒ REFUSED.
#   - KUBECTL may be overridden (tests). Output is one line per repo, then a summary line.
set -euo pipefail
KUBECTL=${KUBECTL:-kubectl}
CODE_LABEL=${DAGSTER_CODE_LABEL:-component=user-deployments}
WEB_LABEL=${DAGSTER_WEB_LABEL:-component=dagster-webserver}

pod() { # <ctx> <ns> <label>
  "$KUBECTL" --context "$1" -n "$2" get pods -l "$3" --field-selector=status.phase=Running \
    -o jsonpath='{.items[0].metadata.name}'
}

layout() { # <ctx> <ns>
  local p
  p=$(pod "$1" "$2" "$CODE_LABEL")
  # No code location running (Dagster not deployed yet): no schedule exists that could be lost.
  [ -n "$p" ] || { echo "dagster-layout: no running code-location pod ($CODE_LABEL) — no repo is wired yet, nothing to check"; return 0; }
  # One read-only shell pass over the mirrors: <domain> <marker 0|1> <defs sha|-> <recorded sha|-> <schedules.yml 0|1>
  # shellcheck disable=SC2016
  "$KUBECTL" --context "$1" -n "$2" exec "$p" -c repo-sync -- sh -c '
    for m in "$1"/*.git; do
      [ -d "$m" ] || continue
      d=$(basename "$m" .git)
      has() { git -C "$m" cat-file -e "main:$1" 2>/dev/null && echo 1 || echo 0; }
      defs=-; rec=-
      if [ "$(has data/dagster/definitions.py)" = 1 ]; then defs=$(git -C "$m" show main:data/dagster/definitions.py | sha256sum | cut -c1-64); fi
      if [ "$(has os/generated.yml)" = 1 ]; then
        rec=$(git -C "$m" show main:os/generated.yml | sed -n "s/^ *data\/dagster\/definitions.py: *\([0-9a-f]\{64\}\).*/\1/p" | head -1)
        [ -n "$rec" ] || rec=-
      fi
      echo "$d $(has os/layout.yml) $defs $rec $(has os/schedules.yml)"
    done' sh "${DAGSTER_MIRRORS:-/repos-checkout/.mirrors}" | classify
}

classify() { # stdin: the lines `layout` reads; stdout: one verdict per repo + a summary
  local d marker defs rec sched verdict refused=0 native=0 legacy=0
  while read -r d marker defs rec sched; do
    [ -n "$d" ] || continue
    if [ "$marker" = 1 ] && [ "$defs" != - ] && [ "$rec" != - ]; then
      if [ "$defs" = "$rec" ]; then verdict=NATIVE; native=$((native + 1))
      else verdict="REFUSED (data/dagster/definitions.py sha256 ${defs:0:12} != recorded ${rec:0:12}: the domain would be skipped)"; refused=$((refused + 1)); fi
    else
      verdict="LEGACY ($([ "$marker" = 1 ] && echo 'migrated, no recorded module yet' || echo 'not migrated'); schedules from os/schedules.yml$([ "$sched" = 1 ] || echo ' (none) + weekly maintenance'))"
      legacy=$((legacy + 1))
    fi
    echo "   $d: $verdict"
  done
  echo "dagster-layout: native=$native legacy=$legacy refused=$refused"
  [ "$refused" -eq 0 ]
}

schedules() { # <ctx> <ns> — prints the schedule count of the running location
  local p
  p=$(pod "$1" "$2" "$WEB_LABEL")
  [ -n "$p" ] || { echo "dagster-schedules: no running webserver pod ($WEB_LABEL) — counting 0" >&2; echo 0; return 0; }
  "$KUBECTL" --context "$1" -n "$2" exec "$p" -- python3 -c '
import json, urllib.request
q = {"query": "{ repositoriesOrError { ... on RepositoryConnection { nodes { schedules { name } } } } }"}
r = json.load(urllib.request.urlopen(urllib.request.Request("http://localhost:80/graphql", json.dumps(q).encode(), {"content-type": "application/json"}), timeout=30))
print(sum(len(n["schedules"]) for n in r["data"]["repositoriesOrError"]["nodes"]))'
}

compare() { # <before> <after> — exit 1 when the count dropped
  local before=$1 after=$2
  if [ "$after" -lt "$before" ]; then
    echo "SCHEDULES_DROPPED: the Dagster location defines $after schedule(s), $before before the deploy"; return 1
  fi
  echo "dagster-schedules: $after schedule(s) (before: $before)"
}

case "${1:-}" in
  layout) shift; layout "$@" ;;
  classify) classify ;;
  schedules) shift; schedules "$@" ;;
  compare) shift; compare "$@" ;;
  *) echo "usage: $0 layout <ctx> <ns> | schedules <ctx> <ns> | compare <before> <after> | classify (stdin)" >&2; exit 2 ;;
esac
