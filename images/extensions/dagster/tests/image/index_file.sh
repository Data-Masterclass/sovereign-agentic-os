#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
#
# The REAL repo-sync (in the image) fetches the OS index with its bearer and writes the snapshot the
# principals sensor reads (`OS_INDEX_FILE`); the user-code container holds no bearer. Twin: an index
# that refuses the bearer leaves no snapshot (never a stale or empty one that would read as "all
# active").
#   index_file.sh <dagster image>
set -eu
IMAGE="${1:?usage: index_file.sh <dagster image>}"
docker run --rm -e HOME=/tmp "$IMAGE" sh -c '
set -eu
mkdir -p /tmp/co
cat > /tmp/index.py <<PY
import http.server, json, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get("authorization") != "Bearer good-bearer":
            self.send_response(401); self.end_headers(); return
        b = json.dumps({"domains": [{"name": "sales", "principals": [{"id": "bea", "active": False}]}]}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", 18765), H).serve_forever()
PY
python3 /tmp/index.py &
sleep 1
run() { # bearer checkout
  ( POD_NAME=x-dagster-user-deployments-sovereign-0 POD_IP=127.0.0.1 REPO_SYNC_ENABLED=true REPO_SYNC_INDEX_URL=http://127.0.0.1:18765/ \
    REPO_SYNC_GIT_BASE=/nowhere REPO_SYNC_CHECKOUT="$2" REPO_SYNC_INTERVAL=1 REPO_SYNC_STATUS_PORT=18766 DAGSTER_RELOAD_LOCATION= \
    AGENT_RUNTIME_TOKEN="$1" timeout 6 sh /opt/dagster/app/repo-sync.sh >/dev/null 2>&1 || true )
}
mkdir -p /tmp/good /tmp/bad
run good-bearer /tmp/good
run wrong-bearer /tmp/bad
python3 - <<PY
import json, os, sys
sys.path.insert(0, "/opt/dagster/app")
import os_projects as osp
good = osp.read_index_file("/tmp/good/.os-index.json")
assert good is not None, "repo-sync wrote no index snapshot"
assert osp.inactive_principals(good) == {"bea"}, good
assert not os.path.exists("/tmp/bad/.os-index.json"), "a refused fetch must leave no snapshot"
print("index_file: ok — snapshot written with the bearer, none without")
PY
'
