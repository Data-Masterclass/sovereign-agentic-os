#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# repo-sync-reload-retry.test.sh — a reloadRepositoryLocation that fails is RETRIED next pass
# =============================================================================
#   bash scripts/tests/repo-sync-reload-retry.test.sh
#
# AREA:       Dagster image (images/extensions/dagster/repo-sync.sh)
# FEATURE:    repo-sync reloads the code location until the webserver accepts it
# USER STORY: As the operator I want a deploy that rolls the code location and the webserver
#             together never to leave Dagster with zero schedules. The code server boots on an
#             EMPTY checkout and only shows the domains after repo-sync's reload; dev on 2026-11-24
#             lost every schedule because that ONE reload hit the old webserver mid-rollout (HTTP
#             405) and was never tried again.
# ARCHITECTURE:
#   - The REAL repo-sync.sh, sourced with REPO_SYNC_LIB=1 (it stops before its loop), its passes
#     driven by `sync_pass`; the domain sync is stubbed to "repointed" on the first pass only.
#   - A local stand-in for the webserver's GraphQL endpoint answers 405 (the old webserver's answer
#     to a POST on a path it does not serve) until told otherwise, then a real reload result.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
TMP=$(mktemp -d)
SERVER_PID=
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

# The stand-in webserver: POST /tools/dagster/graphql answers 405 while $TMP/mode says "old", then
# a WorkspaceLocationEntry; every request is logged.
python3 - "$TMP" <<'PY' &
import http.server, json, os, sys
tmp = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0); self.rfile.read(n)
        with open(os.path.join(tmp, "requests"), "a") as f: f.write(self.path + "\n")
        mode = open(os.path.join(tmp, "mode")).read().strip() if os.path.exists(os.path.join(tmp, "mode")) else "old"
        if mode == "old" or self.path != "/tools/dagster/graphql":
            self.send_response(405); self.end_headers(); return
        body = json.dumps({"data": {"reloadRepositoryLocation": {"__typename": "WorkspaceLocationEntry"}}}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(body)
s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(os.path.join(tmp, "port"), "w").write(str(s.server_port))
s.serve_forever()
PY
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null || true
for _ in $(seq 1 50); do [ -s "$TMP/port" ] && break; sleep 0.1; done
PORT=$(cat "$TMP/port")

export REPO_SYNC_LIB=1 REPO_SYNC_ENABLED=true REPO_SYNC_CHECKOUT="$TMP/checkout" REPO_SYNC_STATUS_PORT=0 POD_IP=127.0.0.1
export DAGSTER_GRAPHQL_URL="http://127.0.0.1:$PORT/tools/dagster/graphql" DAGSTER_RELOAD_LOCATION=sovereign
unset POD_NAME
# shellcheck disable=SC1091
. images/extensions/dagster/repo-sync.sh >"$TMP/log" 2>&1
set +e
# Stubs for the parts that need git, dbt and os-ui: pass 1 repoints one domain, later passes do not.
PASS=0
index_domains() { echo sales; }
# shellcheck disable=SC2034  # REPOINTED is read by the sourced sync_pass
sync_domain() { [ "$PASS" = 1 ] && REPOINTED=1; return 0; }
publish_live() { return 0; }
prune_removed() { return 0; }
aggregate_status() { return 0; }

PASS=1; sync_pass >>"$TMP/log" 2>&1
check "pass 1: the reload was attempted after the repoint" "/tools/dagster/graphql" "$(cat "$TMP/requests" 2>/dev/null)"
check "pass 1: the failed reload is logged" "reloadRepositoryLocation failed" "$(cat "$TMP/log")"
check "pass 1: the reload stays pending" "1" "$RELOAD_PENDING"

PASS=2; sync_pass >>"$TMP/log" 2>&1
n=$(grep -c . "$TMP/requests")
check "pass 2 (nothing repointed): the pending reload is RETRIED" "2" "$n"

echo new > "$TMP/mode"
PASS=3; sync_pass >>"$TMP/log" 2>&1
check "pass 3: the webserver accepts the reload" "reload sovereign -> WorkspaceLocationEntry" "$(cat "$TMP/log")"
check "pass 3: nothing is pending any more" "0" "$RELOAD_PENDING"

PASS=4; sync_pass >>"$TMP/log" 2>&1
n=$(grep -c . "$TMP/requests")
check "NEGATIVE: pass 4 (nothing repointed, nothing pending) does not reload again" "3" "$n"

finish repo-sync-reload-retry
