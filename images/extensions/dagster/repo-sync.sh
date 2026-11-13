#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
#
# repo-sync — sidecar on the Dagster user-code Deployment (engine rebuild B1, concept §2.4).
#
# WHAT: every REPO_SYNC_INTERVAL seconds, for each domain in REPO_SYNC_DOMAINS, fetch
#   git://os-repos/<domain>.git (the read-only git daemon on the os-ui pod), and when `main`
#   moved: check the commit out as a worktree under /repos-checkout/<domain>/<sha>, run
#   `dbt parse` there, and ONLY on success repoint /repos-checkout/<domain>/current → <sha>.
#   A commit that fails to parse never replaces the last good checkout — Dagster keeps
#   scheduling the previous commit (checklist D8). The outcome of every domain is written to
#   /repos-checkout/status.json and served on REPO_SYNC_STATUS_PORT (cluster-local) so os-ui
#   can show "commit abc123 failed dbt parse: … — schedules still run def456".
#
# WHY A SIDECAR: the code location must load from a VALIDATED commit, not from whatever the
#   OS last wrote. Commit first, validate second; the gate is deployment, as in any CI.
#
# ENV:
#   REPO_SYNC_ENABLED      "true" to run; anything else idles (logs once, sleeps) so the sidecar
#                          is inert on an install without osUI.dataProjectGit.enabled.
#   REPO_SYNC_DOMAINS      comma-separated domain list (B2 adds discovery; today explicit).
#   REPO_SYNC_GIT_BASE     default git://os-repos (Service `os-repos`, port 9418).
#   REPO_SYNC_CHECKOUT     default /repos-checkout (emptyDir shared with the user-code container).
#   REPO_SYNC_INTERVAL     seconds between fetches (default 15).
#   REPO_SYNC_STATUS_PORT  port for the status.json server (default 8089).
#   DAGSTER_RELOAD_LOCATION  when set, POST reloadRepositoryLocation(<name>) to
#                          DAGSTER_GRAPHQL_URL after a successful repoint. Empty = skip (TODO B2:
#                          the `sovereign` multi-project code location does not exist yet).
#   OS_PRINCIPAL           exported for `dbt parse` only (profiles.yml requires it); set to a
#                          non-entitled name — parse never connects to Trino.
#
# Requires: git, dbt (dbt-trino), python3 (status.json + the status server) — all in the image.
set -eu

ENABLED="${REPO_SYNC_ENABLED:-false}"
DOMAINS="${REPO_SYNC_DOMAINS:-}"
BASE="${REPO_SYNC_GIT_BASE:-git://os-repos}"
CHECKOUT="${REPO_SYNC_CHECKOUT:-/repos-checkout}"
INTERVAL="${REPO_SYNC_INTERVAL:-15}"
PORT="${REPO_SYNC_STATUS_PORT:-8089}"
RELOAD_LOCATION="${DAGSTER_RELOAD_LOCATION:-}"
GRAPHQL="${DAGSTER_GRAPHQL_URL:-http://agentic-os-dagster-webserver:80/graphql}"
export OS_PRINCIPAL="${OS_PRINCIPAL:-repo-sync}"

log() { printf '%s repo-sync: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

mkdir -p "$CHECKOUT/.mirrors" "$CHECKOUT/.status"

if [ "$ENABLED" != "true" ]; then
  log "REPO_SYNC_ENABLED is not 'true' — idling (enable osUI.dataProjectGit + REPO_SYNC_ENABLED to sync domain repos)"
  printf '{"enabled": false, "domains": {}}\n' > "$CHECKOUT/status.json"
  while true; do sleep 3600; done
fi

# Serve status.json (and the checkout tree) on a cluster-local port.
( cd "$CHECKOUT" && exec python3 -m http.server "$PORT" --bind 0.0.0.0 ) >/dev/null 2>&1 &
log "status on :$PORT, base $BASE, domains [$DOMAINS], every ${INTERVAL}s"

# Write one domain's status fragment (JSON, via python for correct escaping).
write_status() { # domain head current lastGood error
  python3 - "$CHECKOUT/.status/$1.json" "$1" "$2" "$3" "$4" "$5" <<'PY'
import json, sys, time
path, domain, head, current, last_good, error = sys.argv[1:7]
json.dump({"domain": domain, "head": head or None, "current": current or None,
           "lastGood": last_good or None, "error": error or None,
           "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, open(path, "w"))
PY
}

# Aggregate the fragments into status.json atomically.
aggregate_status() {
  python3 - "$CHECKOUT" <<'PY'
import glob, json, os, sys, time
root = sys.argv[1]
domains = {}
for f in sorted(glob.glob(os.path.join(root, ".status", "*.json"))):
    try:
        d = json.load(open(f)); domains[d["domain"]] = d
    except Exception:
        pass
tmp = os.path.join(root, "status.json.tmp")
json.dump({"enabled": True, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "domains": domains}, open(tmp, "w"))
os.replace(tmp, os.path.join(root, "status.json"))
PY
}

reload_location() {
  [ -n "$RELOAD_LOCATION" ] || { log "reloadRepositoryLocation skipped (DAGSTER_RELOAD_LOCATION unset — TODO B2)"; return 0; }
  python3 - "$GRAPHQL" "$RELOAD_LOCATION" <<'PY' || log "reloadRepositoryLocation failed (non-fatal)"
import json, sys, urllib.request
url, name = sys.argv[1:3]
q = {"query": "mutation($n: String!) { reloadRepositoryLocation(repositoryLocationName: $n) { __typename } }", "variables": {"n": name}}
req = urllib.request.Request(url, data=json.dumps(q).encode(), headers={"Content-Type": "application/json"})
print(urllib.request.urlopen(req, timeout=20).read().decode()[:200])
PY
}

sync_domain() { # domain
  d="$1"
  mirror="$CHECKOUT/.mirrors/$d.git"
  mkdir -p "$CHECKOUT/$d"
  if [ ! -d "$mirror" ]; then
    git clone --bare --quiet "$BASE/$d.git" "$mirror" 2>/dev/null || { write_status "$d" "" "$(readlink "$CHECKOUT/$d/current" 2>/dev/null | xargs -n1 basename 2>/dev/null)" "" "clone failed: $BASE/$d.git unreachable or missing"; return 0; }
  fi
  if ! git -C "$mirror" fetch --quiet origin "+refs/heads/main:refs/heads/main" 2>/dev/null; then
    write_status "$d" "" "$(readlink "$CHECKOUT/$d/current" 2>/dev/null | xargs -n1 basename 2>/dev/null)" "" "fetch failed"
    return 0
  fi
  head="$(git -C "$mirror" rev-parse main 2>/dev/null || true)"
  [ -n "$head" ] || { write_status "$d" "" "" "" "no commits yet"; return 0; }
  current="$(readlink "$CHECKOUT/$d/current" 2>/dev/null | xargs -n1 basename 2>/dev/null || true)"
  if [ "$head" = "$current" ]; then
    write_status "$d" "$head" "$current" "$current" ""
    return 0
  fi
  wt="$CHECKOUT/$d/$head"
  if [ ! -d "$wt" ]; then
    git -C "$mirror" worktree prune >/dev/null 2>&1 || true
    git -C "$mirror" worktree add --detach --quiet "$wt" "$head" 2>/dev/null || { write_status "$d" "$head" "$current" "$current" "worktree add failed"; return 0; }
  fi
  log "$d: parsing $head"
  if out="$(cd "$wt" && dbt parse --profiles-dir . --no-use-colors --quiet 2>&1)"; then
    ln -sfn "$head" "$CHECKOUT/$d/current.tmp" && mv -T "$CHECKOUT/$d/current.tmp" "$CHECKOUT/$d/current"
    write_status "$d" "$head" "$head" "$head" ""
    log "$d: current → $head"
    reload_location
    # Drop older worktrees (keep current + the previous good one).
    for old in "$CHECKOUT/$d"/*/; do
      sha="$(basename "$old")"
      case "$sha" in "$head"|"$current"|current|current.tmp) ;; *) git -C "$mirror" worktree remove --force "$old" >/dev/null 2>&1 || rm -rf "$old" ;; esac
    done
  else
    err="$(printf '%s' "$out" | tail -n 20 | tr '\n' ' ' | cut -c1-900)"
    write_status "$d" "$head" "$current" "$current" "dbt parse failed: $err"
    log "$d: $head failed dbt parse — schedules keep running ${current:-nothing}"
  fi
}

while true; do
  IFS=','
  for d in $DOMAINS; do
    d="$(printf '%s' "$d" | tr -d ' ')"
    [ -n "$d" ] || continue
    sync_domain "$d" || log "$d: unexpected error (continuing)"
  done
  unset IFS
  aggregate_status
  sleep "$INTERVAL"
done
