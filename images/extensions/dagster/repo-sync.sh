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
#   A commit dbt refused is parsed ONCE: its verdict is cached per (domain, sha) under .verdicts/
#   and re-published each pass without re-running dbt, until `main` moves.
#   The outcome of every domain is written to /repos-checkout/status.json and served on
#   REPO_SYNC_STATUS_PORT so os-ui can show "commit abc123 failed dbt parse: … — schedules
#   still run def456". WP-16 (01 M2, 10 F6/F10) — the feed: the same server also answers, read-only,
#   `/verdicts/<domain>/<sha>.json` (dbt's verdict for that commit, passed or refused) and
#   `/manifests/<domain>/<sha>/{manifest,semantic_manifest}.json` (dbt's own artifacts of a commit
#   that parsed), so os-ui and metric-compile read the commit Dagster runs instead of re-parsing.
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
#   pod's env (set from the run tags by repo.py), never from this sidecar.
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
#   REPO_SYNC_PARSE_TIMEOUT  seconds before one `dbt parse` is abandoned (default 600; a timeout is
#                          retried, never cached as a refusal).
#   POD_IP                 downward-API `status.podIP` (chart-set). The status server binds THIS
#                          address, not 0.0.0.0, so it is reachable only through the pod's own IP.
#                          Unset => 127.0.0.1 (inside the pod only) — fail-CLOSED, review B2-review-L5.
#   REPO_SYNC_STATUS_TOKEN bearer the status server requires (default: AGENT_RUNTIME_TOKEN, the same
#                          cluster-internal bearer the OS repo-index route accepts). Set and not the
#                          shipped placeholder => every request must carry `Authorization: Bearer`.
#                          Empty => unauthenticated, and the sidecar SAYS so at startup.
#   DAGSTER_RELOAD_LOCATION  code location to reload after a repoint (default "sovereign"; empty = skip).
#   DAGSTER_GRAPHQL_URL    the webserver's /graphql, under its --path-prefix (/tools/dagster); the chart
#                          always sets it. The fallback below only takes effect from the next image build.
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
# The shipped placeholder is NOT a credential. The status server already treats it as empty; strip
# it HERE too, before anything reads $STATUS_TOKEN, so the startup log cannot say "auth: bearer"
# about a default nobody set (B3-review-L-4). One rule, one place.
if [ "$STATUS_TOKEN" = "dev-only-insecure-agent-runtime-token" ]; then
  STATUS_TOKEN=""
fi
RELOAD_LOCATION="${DAGSTER_RELOAD_LOCATION-sovereign}"
GRAPHQL="${DAGSTER_GRAPHQL_URL:-http://agentic-os-dagster-webserver:80/tools/dagster/graphql}"

log() { printf '%s repo-sync: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

mkdir -p "$CHECKOUT/.mirrors" "$CHECKOUT/.status" "$CHECKOUT/.verdicts"

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

# Serve status.json and the read-only feed below — nothing else — bound to the POD's own IP (never 0.0.0.0) and behind a
# bearer when one is configured. Review B2-review-L5: the file names every domain and its parse
# errors — not secret, but not public either, and a wildcard bind is a wider surface than the job
# needs. WP-16: Service `dagster-repo-status` exposes it when `dagsterRepoStatus.enabled`, and the
# NetworkPolicy dagster-code-location-ingress admits only os-ui, os-ui-worker and metric-compile.
python3 - "$CHECKOUT" "$PORT" "$BIND" "$STATUS_TOKEN" "$(dirname "$0")" <<'PY' >/dev/null 2>&1 &
import hmac, http.server, os, re, sys
root, port, bind, token, app = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]
sys.path.insert(0, app)
import os_projects  # noqa: E402 — the one place that knows where a repo's dbt project lives
DOMAIN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
SHA = re.compile(r"^[0-9a-f]{40}$")
ARTIFACTS = ("manifest.json", "semantic_manifest.json")


def resolve(path):
    """The file a feed path names, or None. Only names the regexes admit; never a `..`."""
    if path in ("/", "/status.json"):
        return os.path.join(root, "status.json")
    parts = path.strip("/").split("/")
    if len(parts) == 3 and parts[0] == "verdicts" and DOMAIN.match(parts[1]) and parts[2].endswith(".json") and SHA.match(parts[2][:-5]):
        return os.path.join(root, ".verdicts", parts[1], parts[2])
    if len(parts) == 4 and parts[0] == "manifests" and DOMAIN.match(parts[1]) and SHA.match(parts[2]) and parts[3] in ARTIFACTS:
        repo = os.path.join(root, parts[1], parts[2])
        try:
            return os.path.join(os_projects.dbt_dir(repo), "target", parts[3])
        except Exception:
            return None
    return None
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
        path = self.path.split("?")[0]
        f = resolve(path)
        if f is None:
            self.send_response(404); self.end_headers(); return
        if not self._authed():
            self.send_response(401); self.send_header("www-authenticate", "Bearer"); self.end_headers(); return
        try:
            body = open(f, "rb").read()
        except OSError:
            if path not in ("/", "/status.json"):
                self.send_response(404); self.end_headers(); return
            body = b'{"enabled": true, "domains": {}}'
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def log_message(self, *a): pass


http.server.ThreadingHTTPServer((bind, port), H).serve_forever()
PY
log "status on $BIND:$PORT (auth: $([ -n "$STATUS_TOKEN" ] && echo bearer || echo NONE)), base $BASE, index ${INDEX_URL:-off}, extra domains [$DOMAINS], every ${INTERVAL}s"

# Domains from the OS index (newline-separated). Unreachable ⇒ empty (the explicit list still runs)
# and NO .index file is written, so a down index can never look like "every domain was deleted".
# On an answer, the list is also written to $CHECKOUT/.index (the prune below trusts only that).
# The index is also written to $CHECKOUT/.os-index.json (atomically, only after a good fetch): the
# `os_principals` sensor in the user-code container reads that file, so the user-code container —
# and every run pod, which inherits its env — holds no bearer. A failed fetch leaves the last good
# file, which the sensor stops trusting once it is older than its max age.
index_domains() {
  rm -f "$CHECKOUT/.index"
  [ -n "$INDEX_URL" ] || return 0
  python3 - "$INDEX_URL" "$TOKEN" "$CHECKOUT/.index" "$CHECKOUT/.os-index.json" <<'PY' 2>/dev/null || true
import json, os, sys, urllib.request
url, token, out, snapshot = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
req = urllib.request.Request(url, headers={"accept": "application/json", **({"authorization": "Bearer " + token} if token else {})})
try:
    doc = json.loads(urllib.request.urlopen(req, timeout=5).read().decode())
except Exception:
    sys.exit(0)
if not isinstance(doc, dict) or not isinstance(doc.get("domains"), list):
    sys.exit(0)
tmp = snapshot + ".tmp"
with open(tmp, "w") as fh:
    json.dump(doc, fh)
os.replace(tmp, snapshot)
names = [d["name"] for d in doc["domains"] if isinstance(d, dict) and d.get("name")]
tmp = out + ".tmp"
with open(tmp, "w") as fh:
    fh.write("".join(n + "\n" for n in names))
os.replace(tmp, out)
for n in names:
    print(n)
PY
}

# Prune the checkout of every domain the index NO LONGER lists (a deleted domain): its worktrees,
# mirror, status and verdicts go, so `os_projects.discover` stops loading it, and the location is
# reloaded. Only when the index ANSWERED this pass (.index exists) and the domain is not in the
# explicit REPO_SYNC_DOMAINS list. REPO_SYNC_PRUNE=false turns it off.
prune_removed() { # newline-separated list of domains to keep
  [ "${REPO_SYNC_PRUNE:-true}" = "true" ] || return 0
  [ -f "$CHECKOUT/.index" ] || return 0
  keep="$1"
  for dir in "$CHECKOUT"/*/; do
    [ -d "$dir" ] || continue
    d="$(basename "$dir")"
    case "$d" in .*) continue ;; esac
    if ! printf '%s\n' "$keep" | grep -qxF "$d"; then
      rm -rf "$CHECKOUT/$d" "$CHECKOUT/.mirrors/$d.git" "$CHECKOUT/.status/$d.json" "$CHECKOUT/.verdicts/$d".* "$CHECKOUT/.verdicts/$d"
      log "$d: no longer in the OS index — checkout pruned (the domain was deleted)"
      REPOINTED=1
    fi
  done
}

# Write one domain's status fragment (JSON, via python for correct escaping).
# `error` is dbt's own output (tail, verbatim); `errorSummary` is the one line repo-sync logs.
write_status() { # domain head current lastGood error [errorSummary] [parsedAt]
  python3 - "$CHECKOUT/.status/$1.json" "$1" "$2" "$3" "$4" "$5" "${6:-}" "${7:-}" <<'PY'
import json, sys, time
path, domain, head, current, last_good, error, summary, parsed_at = sys.argv[1:9]
json.dump({"domain": domain, "head": head or None, "current": current or None,
           "lastGood": last_good or None, "error": error or None,
           "errorSummary": summary or None, "parsedAt": parsed_at or None,
           "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, open(path, "w"))
PY
}

# Verdict cache per (domain, sha): a commit dbt refused is parsed ONCE, not on every pass until
# `main` moves (01 §5.3, gap G9). The verdict is dbt's own text; a new commit gets a new parse.
# Lives on the checkout emptyDir, so a pod restart parses each head once more — never stale.
VERDICTS="$CHECKOUT/.verdicts"
verdict_file() { printf '%s/%s/%s.json' "$VERDICTS" "$1" "$2"; } # domain sha
save_verdict() { # domain sha error summary
  mkdir -p "$VERDICTS/$1"
  python3 - "$(verdict_file "$1" "$2")" "$3" "$4" <<'PY'
import json, os, sys, time
path, error, summary = sys.argv[1:4]
tmp = path + ".tmp"
json.dump({"ok": False, "error": error, "errorSummary": summary,
           "parsedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, open(tmp, "w"))
os.replace(tmp, path)
PY
}
save_ok_verdict() { # domain sha — the commit parsed: os-ui records it as a passed check (10 F10)
  mkdir -p "$VERDICTS/$1"
  python3 - "$(verdict_file "$1" "$2")" <<'PY'
import json, os, sys, time
path = sys.argv[1]
tmp = path + ".tmp"
json.dump({"ok": True, "parsedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, open(tmp, "w"))
os.replace(tmp, path)
PY
}
cached_status() { # domain head current — re-publish a cached failed verdict; 1 when none
  f="$(verdict_file "$1" "$2")"
  [ -f "$f" ] || return 1
  grep -q '"ok": false' "$f" || return 1   # only a refusal is re-published; a passed sha is `current`
  python3 - "$f" "$CHECKOUT/.status/$1.json" "$1" "$2" "$3" <<'PY'
import json, sys, time
f, path, domain, head, current = sys.argv[1:6]
v = json.load(open(f))
json.dump({"domain": domain, "head": head, "current": current or None, "lastGood": current or None,
           "error": "dbt parse failed: " + v["error"], "errorSummary": v.get("errorSummary"),
           "parsedAt": v.get("parsedAt"),
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

# WP-51: publish what is LIVE in this domain, read from the git tags in the mirror — never from the
# OS. `live` maps `<kind>/<id>` → the commit `live/<kind>/<id>` names, and `inCurrent` says whether
# that commit is in the history Dagster loaded (`current`), i.e. whether the code location runs a
# project that contains the live version. (The project itself follows main's last-good commit:
# resolution F10 keeps repo-sync the single dbt gate.)
publish_live() { # domain
  frag="$CHECKOUT/.status/$1.json"
  mirror="$CHECKOUT/.mirrors/$1.git"
  [ -f "$frag" ] && [ -d "$mirror" ] || return 0
  current="$(readlink "$CHECKOUT/$1/current" 2>/dev/null | xargs -n1 basename 2>/dev/null || true)"
  python3 - "$frag" "$mirror" "$current" <<'PY'
import json, subprocess, sys
frag, mirror, current = sys.argv[1:4]
out = subprocess.run(["git", "-C", mirror, "for-each-ref", "--format=%(refname:strip=3) %(*objectname)%(objectname)", "refs/tags/live"],
                     capture_output=True, text=True).stdout
live = {}
for line in out.splitlines():
    name, _, oids = line.partition(" ")
    commit = oids[:40]  # an annotated tag prints the peeled commit first
    in_current = bool(current) and subprocess.run(["git", "-C", mirror, "merge-base", "--is-ancestor", commit, current]).returncode == 0
    live[name] = {"commit": commit, "inCurrent": in_current}
d = json.load(open(frag))
d["live"] = live
tmp = frag + ".tmp"
json.dump(d, open(tmp, "w"))
import os; os.replace(tmp, frag)
PY
}

# Returns 1 when the webserver did not confirm the reload; the caller keeps it PENDING and retries
# every pass (sync_pass). The code server boots on an EMPTY checkout and shows the domains only
# after a reload, and nothing else reloads it: on 2026-11-24 dev lost every schedule because the
# one reload of a fresh pod hit the OLD webserver mid-rollout (HTTP 405) and was never retried.
reload_location() {
  [ -n "$RELOAD_LOCATION" ] || { log "reloadRepositoryLocation skipped (DAGSTER_RELOAD_LOCATION empty)"; return 0; }
  python3 - "$GRAPHQL" "$RELOAD_LOCATION" <<'PY' || { log "reloadRepositoryLocation failed — retrying next pass (the code location shows no domain until it succeeds)"; return 1; }
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
# Exit status: 0 parsed (manifest written) · 1 dbt itself refused the commit · 75 did not finish
# (timeout, killed e.g. by OOM, dbt missing, or no manifest) — only 1 is ever cached.
parse_project() { # worktree
  python3 "$APP_DIR/os_projects.py" --parse "$1" 2>&1
  rc=$?
  # The project dir follows the repo layout (v1 root, v2 $OS_DBT_PROJECT_DIR) — one rule, in os_projects.py.
  pdir="$(python3 "$APP_DIR/os_projects.py" --dbt-dir "$1" 2>/dev/null || echo "$1")"
  if [ "$rc" = 0 ] && [ ! -f "$pdir/target/manifest.json" ]; then echo "dbt parse exited 0 but wrote no manifest"; return 75; fi
  case "$rc" in 0|1) return "$rc" ;; *) return 75 ;; esac
}

sync_domain() { # domain  (sets REPOINTED=1 when `current` moved)
  d="$1"
  mirror="$CHECKOUT/.mirrors/$d.git"
  mkdir -p "$CHECKOUT/$d"
  if [ ! -d "$mirror" ]; then
    # The canonical repo name first (`domain-<domain>`, design 12), then the pre-layout alias.
    git clone --bare --quiet "$BASE/domain-$d.git" "$mirror" 2>/dev/null || rm -rf "$mirror"
    [ -d "$mirror" ] || git clone --bare --quiet "$BASE/$d.git" "$mirror" 2>/dev/null || { write_status "$d" "" "$(readlink "$CHECKOUT/$d/current" 2>/dev/null | xargs -n1 basename 2>/dev/null)" "" "clone failed: $BASE/$d.git unreachable or missing"; return 0; }
  fi
  # The lifecycle tags travel with main (WP-51): `live/*` as git has them NOW — pruned, so a retired
  # object's tag disappears here too.
  if ! git -C "$mirror" fetch --quiet --prune origin "+refs/heads/main:refs/heads/main" "+refs/tags/live/*:refs/tags/live/*" 2>/dev/null; then
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
  # Already refused by dbt: publish the cached verdict, do not parse (or log) it again.
  if cached_status "$d" "$head" "$current"; then
    return 0
  fi
  wt="$CHECKOUT/$d/$head"
  if [ ! -d "$wt" ]; then
    git -C "$mirror" worktree prune >/dev/null 2>&1 || true
    git -C "$mirror" worktree add --detach --quiet "$wt" "$head" 2>/dev/null || { write_status "$d" "$head" "$current" "$current" "worktree add failed"; return 0; }
  fi
  log "$d: parsing $head"
  prc=0
  out="$(parse_project "$wt")" || prc=$?
  if [ "$prc" = 0 ]; then
    ln -sfn "$head" "$CHECKOUT/$d/current.tmp" && mv -T "$CHECKOUT/$d/current.tmp" "$CHECKOUT/$d/current"
    write_status "$d" "$head" "$head" "$head" "" "" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    save_ok_verdict "$d" "$head"
    log "$d: current → $head"
    REPOINTED=1
    # Drop older worktrees (keep current + the previous good one).
    for old in "$CHECKOUT/$d"/*/; do
      sha="$(basename "$old")"
      case "$sha" in "$head"|"$current"|current|current.tmp) ;; *) git -C "$mirror" worktree remove --force "$old" >/dev/null 2>&1 || rm -rf "$old" ;; esac
    done
  elif [ "$prc" != 1 ]; then
    # Not dbt's verdict: never cached, retried next pass (verifier finding 8).
    err="$(printf '%s' "$out" | tail -n 5 | tr '\n' ' ' | cut -c1-400)"
    write_status "$d" "$head" "$current" "$current" "dbt parse did not finish (will retry): $err"
    log "$d: $head — dbt parse did not finish (exit $prc, not cached, retrying next pass) — schedules keep running ${current:-nothing}"
  else
    err="$(printf '%s' "$out" | tail -n 20 | tr '\n' ' ' | cut -c1-900)"
    # Say WHICH dbt error, not just that there was one (live incident 2026-11, track H).
    why="$(printf '%s' "$out" | python3 "$APP_DIR/os_projects.py" --error-summary 2>/dev/null || echo 'unreadable dbt output')"
    save_verdict "$d" "$head" "$err" "$why"
    cached_status "$d" "$head" "$current"
    log "$d: $head failed dbt parse — schedules keep running ${current:-nothing} — $why (not parsed again until main moves)"
  fi
}

# One pass over every domain. A reload is due when a domain repointed this pass, or when an earlier
# reload was not confirmed (RELOAD_PENDING): a failed reload is retried every pass until the
# webserver accepts it, never dropped.
RELOAD_PENDING=0
sync_pass() {
  REPOINTED=0
  all="$(printf '%s\n%s\n' "$(index_domains)" "$(printf '%s' "$DOMAINS" | tr ',' '\n')" | tr -d ' ' | grep -v '^$' | sort -u || true)"
  for d in $all; do
    case "$d" in *..*|*/*) log "ignoring invalid domain name '$d'"; continue ;; esac
    sync_domain "$d" || log "$d: unexpected error (continuing)"
    publish_live "$d" || log "$d: could not read the live tags (continuing)"
  done
  prune_removed "$all"
  aggregate_status
  if [ "$REPOINTED" = "1" ] || [ "$RELOAD_PENDING" = "1" ]; then
    if reload_location; then RELOAD_PENDING=0; else RELOAD_PENDING=1; fi
  fi
}

# Tests source this file with REPO_SYNC_LIB=1 and drive `sync_pass` themselves
# (scripts/tests/repo-sync-reload-retry.test.sh).
if [ "${REPO_SYNC_LIB:-}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

while true; do
  sync_pass
  sleep "$INTERVAL"
done
