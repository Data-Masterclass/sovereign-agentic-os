#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
#
# repo-sync — sidecar on the Dagster user-code Deployment (engine rebuild B1/B2, concept §2.4).
#
# WHAT: every REPO_SYNC_INTERVAL seconds, discover the domains that have a data-project repo
#   (GET REPO_SYNC_INDEX_URL — the OS's repo index, cluster-internal, runtime bearer — plus the
#   explicit REPO_SYNC_DOMAINS list), fetch git://os-repos/<domain>.git (the read-only git daemon on
#   the os-ui pod), and when `main` moved: check the commit out as a worktree under
#   /repos-checkout/<domain>/<sha>, run `dbt parse` there (which writes target/manifest.json — what
#   the `sovereign` code location loads), and ONLY on success repoint /repos-checkout/<domain>/current
#   → <sha> and reload the Dagster code location once per pass. A commit that fails to parse never
#   replaces the last good checkout — Dagster keeps scheduling the previous commit (checklist D8).
#   The outcome of every domain is written to /repos-checkout/status.json and served (that file
#   ONLY) on REPO_SYNC_STATUS_PORT so os-ui can show "commit abc123 failed dbt parse: … — schedules
#   still run def456".
#
# WHY A SIDECAR: the code location must load from a VALIDATED commit, not from whatever the OS last
#   wrote. Commit first, validate second; the gate is deployment, as in any CI.
#
# SECURITY: `dbt parse` renders Jinja from the repo. The generator never writes user-authored text
#   into a MODEL (an authored body becomes a dbt SOURCE — engine rebuild B2), but it does write
#   authored DESCRIPTIONS into schema.yml, and dbt renders Jinja there too — so parse runs with an
#   ALLOWLISTED environment and NOTHING this container holds reaches dbt while repo files render.
#   That allowlist lives in exactly ONE place, `os_projects.py` (`PARSE_ENV_*` / `dbt_parse`), which
#   this script shells out to — a second allowlist here would drift (review B2-review-H3).
#   This container DOES hold one secret — AGENT_RUNTIME_TOKEN, the cluster-internal bearer the OS
#   repo-index route accepts — and that is the ONLY secret it may ever hold: no Trino password, no
#   mirror token, nothing a `{{ env_var(...) }}` in a repo could exfiltrate. The allowlist keeps
#   even that one out of `dbt parse`. A generated `profiles.yml` reads its credentials from the RUN
#   pod's env (set by `dagster-k8s/config`), never from this sidecar.
#
# ENV:
#   REPO_SYNC_ENABLED      "true" to run; anything else makes the sidecar inert on an install
#                          without osUI.dataProjectGit.enabled (idle on the code-server pod,
#                          exit 0 anywhere it cannot prove it is not a Dagster run pod).
#   REPO_SYNC_INDEX_URL    the OS repo index (default http://os-ui:3000/api/data/projects); empty = off.
#   AGENT_RUNTIME_TOKEN    the shared runtime bearer the index route accepts (Secret-mounted). The
#                          ONLY secret this container may hold; the parse allowlist keeps it out
#                          of dbt (os_projects.PARSE_ENV_PASSTHROUGH).
#   REPO_SYNC_DOMAINS      comma-separated extra domains (optional; union with the index).
#   REPO_SYNC_GIT_BASE     default git://os-repos (Service `os-repos`, port 9418).
#   REPO_SYNC_CHECKOUT     default /repos-checkout (emptyDir shared with the user-code container).
#   REPO_SYNC_INTERVAL     seconds between passes (default 15).
#   REPO_SYNC_STATUS_PORT  port for the status.json server (default 8089).
#   POD_IP                 downward-API `status.podIP` (chart-set). The status server binds THIS
#                          address, not 0.0.0.0, so it is reachable only through the pod's own IP.
#                          Unset => 127.0.0.1 (inside the pod only) — fail-CLOSED, review B2-review-L5.
#   REPO_SYNC_STATUS_TOKEN bearer the status server requires (default: AGENT_RUNTIME_TOKEN, the same
#                          cluster-internal bearer the OS repo-index route accepts). Set and not the
#                          shipped placeholder => every request must carry `Authorization: Bearer`.
#                          Empty => unauthenticated, and the sidecar SAYS so at startup.
#   DAGSTER_RELOAD_LOCATION  code location to reload after a repoint (default "sovereign"; empty = skip).
#   DAGSTER_GRAPHQL_URL    the webserver's /graphql.
#   POD_NAME               downward-API `metadata.name` (chart-set). A Dagster RUN pod inherits
#                          this whole sidecar through `run_k8s_config.pod_spec_config.containers`
#                          (the subchart derives that from `sidecarContainers`), and a sidecar that
#                          never exits keeps the run Job Running forever — so repo-sync exits 0 in
#                          a run pod. Review B2-review-M1.
#
# Requires: git, dbt (dbt-trino), python3 (JSON + the status server) — all in the image.
set -eu

ENABLED="${REPO_SYNC_ENABLED:-false}"
INDEX_URL="${REPO_SYNC_INDEX_URL:-http://os-ui:3000/api/data/projects}"
TOKEN="${AGENT_RUNTIME_TOKEN:-}"
DOMAINS="${REPO_SYNC_DOMAINS:-}"
BASE="${REPO_SYNC_GIT_BASE:-git://os-repos}"
CHECKOUT="${REPO_SYNC_CHECKOUT:-/repos-checkout}"
INTERVAL="${REPO_SYNC_INTERVAL:-15}"
PORT="${REPO_SYNC_STATUS_PORT:-8089}"
BIND="${POD_IP:-127.0.0.1}"
STATUS_TOKEN="${REPO_SYNC_STATUS_TOKEN:-${AGENT_RUNTIME_TOKEN:-}}"
RELOAD_LOCATION="${DAGSTER_RELOAD_LOCATION-sovereign}"
GRAPHQL="${DAGSTER_GRAPHQL_URL:-http://agentic-os-dagster-webserver:80/graphql}"

log() { printf '%s repo-sync: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

mkdir -p "$CHECKOUT/.mirrors" "$CHECKOUT/.status"

# A Dagster RUN pod carries this sidecar too (the subchart copies `sidecarContainers` into
# `run_k8s_config.pod_spec_config.containers`), and a K8s Job only completes when EVERY container
# exits — so a run pod's copy must exit immediately. `os_projects.ensure_checkout` clones and
# parses the pinned commit inside the run pod; nothing here is needed there. Review B2-review-M1.
case "${POD_NAME:-}" in
  dagster-run-*|dagster-step-*)
    log "in a Dagster run pod (${POD_NAME}) — nothing to sync here, exiting 0 so the run Job can complete"
    exit 0
    ;;
esac

if [ "$ENABLED" != "true" ]; then
  log "REPO_SYNC_ENABLED is not 'true' — not syncing (enable osUI.dataProjectGit + REPO_SYNC_ENABLED to sync domain repos)"
  printf '{"enabled": false, "domains": {}}\n' > "$CHECKOUT/status.json"
  if [ -n "${POD_NAME:-}" ]; then
    # POD_NAME is set and did NOT match a run pod above, so this is the code-server Deployment:
    # idle quietly (a container that exits under restartPolicy: Always is restarted forever and
    # eventually backs off, which reads as a broken default install).
    while true; do sleep 3600; done
  fi
  # POD_NAME unset (chart not carrying the downward-API env) ⇒ we cannot prove this is not a run
  # pod, and an idle sleeper there would keep every run Job Running. Exit, which is the safe half
  # of that trade. Review B2-review-M1.
  log "POD_NAME unset — exiting 0 rather than idling, so a run pod's Job can complete"
  exit 0
fi

# Serve status.json — and ONLY status.json — bound to the POD's own IP (never 0.0.0.0) and behind a
# bearer when one is configured. Review B2-review-L5: the file names every domain and its parse
# errors — not secret, but not public either, and a wildcard bind is a wider surface than the job
# needs. No Service exposes this port today and os-ui does not read it (docs/components/dagster.md
# -> "Known limits").
python3 - "$CHECKOUT" "$PORT" "$BIND" "$STATUS_TOKEN" <<'PY' >/dev/null 2>&1 &
import hmac, http.server, os, sys
root, port, bind, token = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
if token == "dev-only-insecure-agent-runtime-token":
    token = ""  # the shipped placeholder is not a credential


class H(http.server.BaseHTTPRequestHandler):
    def _authed(self):
        if not token:
            return True
        header = self.headers.get("authorization", "")
        got = header[7:] if header[:7].lower() == "bearer " else ""
        return bool(got) and hmac.compare_digest(got, token)

    def do_GET(self):
        if self.path.split("?")[0] not in ("/", "/status.json"):
            self.send_response(404); self.end_headers(); return
        if not self._authed():
            self.send_response(401); self.send_header("www-authenticate", "Bearer"); self.end_headers(); return
        try:
            body = open(os.path.join(root, "status.json"), "rb").read()
        except OSError:
            body = b'{"enabled": true, "domains": {}}'
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def log_message(self, *a): pass


http.server.ThreadingHTTPServer((bind, port), H).serve_forever()
PY
log "status on $BIND:$PORT (auth: $([ -n "$STATUS_TOKEN" ] && echo bearer || echo NONE)), base $BASE, index ${INDEX_URL:-off}, extra domains [$DOMAINS], every ${INTERVAL}s"

# Domains from the OS index (newline-separated). Unreachable ⇒ empty (the explicit list still runs).
index_domains() {
  [ -n "$INDEX_URL" ] || return 0
  python3 - "$INDEX_URL" "$TOKEN" <<'PY' 2>/dev/null || true
import json, sys, urllib.request
url, token = sys.argv[1], sys.argv[2]
req = urllib.request.Request(url, headers={"accept": "application/json", **({"authorization": "Bearer " + token} if token else {})})
try:
    doc = json.loads(urllib.request.urlopen(req, timeout=5).read().decode())
    for d in doc.get("domains", []):
        if isinstance(d, dict) and d.get("name"):
            print(d["name"])
except Exception:
    pass
PY
}

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
  [ -n "$RELOAD_LOCATION" ] || { log "reloadRepositoryLocation skipped (DAGSTER_RELOAD_LOCATION empty)"; return 0; }
  python3 - "$GRAPHQL" "$RELOAD_LOCATION" <<'PY' || log "reloadRepositoryLocation failed (non-fatal — the daemon reloads on its own schedule)"
import json, sys, urllib.request
url, name = sys.argv[1:3]
q = {"query": "mutation($n: String!) { reloadRepositoryLocation(repositoryLocationName: $n) { __typename ... on PythonError { message } ... on RepositoryLocationNotFound { message } } }", "variables": {"n": name}}
req = urllib.request.Request(url, data=json.dumps(q).encode(), headers={"Content-Type": "application/json"})
body = json.loads(urllib.request.urlopen(req, timeout=30).read().decode())
res = (body.get("data") or {}).get("reloadRepositoryLocation") or {}
print("reload", name, "->", res.get("__typename"), (res.get("message") or "")[:200])
sys.exit(0 if res.get("__typename") == "WorkspaceLocationEntry" else 1)
PY
}

# `dbt parse` with a scrubbed environment: ONE allowlist, owned by os_projects.py, shared with the
# run-pod bootstrap (`ensure_checkout`) so the two can never drift. Review B2-review-H3.
APP_DIR="${APP_DIR:-$(dirname "$0")}"
parse_project() { # worktree
  python3 "$APP_DIR/os_projects.py" --parse "$1" 2>&1 && [ -f "$1/target/manifest.json" ]
}

sync_domain() { # domain  (sets REPOINTED=1 when `current` moved)
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
  if out="$(parse_project "$wt")"; then
    ln -sfn "$head" "$CHECKOUT/$d/current.tmp" && mv -T "$CHECKOUT/$d/current.tmp" "$CHECKOUT/$d/current"
    write_status "$d" "$head" "$head" "$head" ""
    log "$d: current → $head"
    REPOINTED=1
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
  REPOINTED=0
  all="$(printf '%s\n%s\n' "$(index_domains)" "$(printf '%s' "$DOMAINS" | tr ',' '\n')" | tr -d ' ' | grep -v '^$' | sort -u || true)"
  for d in $all; do
    case "$d" in *..*|*/*) log "ignoring invalid domain name '$d'"; continue ;; esac
    sync_domain "$d" || log "$d: unexpected error (continuing)"
  done
  aggregate_status
  [ "$REPOINTED" = "1" ] && reload_location
  sleep "$INTERVAL"
done
