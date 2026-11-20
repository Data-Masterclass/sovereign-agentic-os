#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Real Dagster for the delete-domain proof (tests/domain-delete/dagster.int.test.ts): the image we
# ship runs dagster-webserver on repo.py (location `sovereign`) and repo-sync.sh, exactly as the
# user-code pod does. The OS repo index is stood in by a 10-line server that lists the bare repos
# in $DD_REPOS (the directory os-ui's `OS_REPOS_DIR` points at), which is what os-ui's
# /api/data/projects answers from. Deleting a repo there is therefore seen by repo-sync as a
# deleted domain.
#
#   sh images/extensions/dagster/tests/image/domain-prune.sh <image> <repos-dir> [port]   # start
#   docker rm -f soa-dd-dagster                                                           # stop
set -eu
IMAGE="${1:?usage: domain-prune.sh <dagster image> <repos dir> [port]}"
REPOS="${2:?repos dir}"
PORT="${3:-18590}"
NAME="${DD_DAGSTER_NAME:-soa-dd-dagster}"
docker rm -f "$NAME" >/dev/null 2>&1 || true
chmod -R a+rwX "$REPOS"
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:3000" -v "$REPOS:/repos" \
  -e REPO_SYNC_ENABLED=true -e REPO_SYNC_GIT_BASE=file:///repos -e REPO_SYNC_INTERVAL=3 \
  -e REPO_SYNC_INDEX_URL=http://127.0.0.1:8090/ -e REPO_SYNC_CHECKOUT=/tmp/checkout \
  -e DAGSTER_GRAPHQL_URL=http://127.0.0.1:3000/graphql -e DAGSTER_RELOAD_LOCATION=sovereign \
  -e DAGSTER_HOME=/tmp/dh -e POD_NAME=dd-code-server -e HOME=/tmp \
  -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0="*" \
  --entrypoint /bin/sh "$IMAGE" -c '
set -e
mkdir -p /tmp/dh /tmp/checkout && : > /tmp/dh/dagster.yaml
cat > /tmp/workspace.yaml <<YAML
load_from:
  - python_file: { relative_path: /opt/dagster/app/repo.py, location_name: sovereign, working_directory: /opt/dagster/app }
YAML
python3 - <<PY &
import http.server, json, os
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        names = sorted(n[len("domain-"):-4] for n in os.listdir("/repos") if n.startswith("domain-") and n.endswith(".git"))
        body = json.dumps({"domains": [{"name": n} for n in names]}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", 8090), H).serve_forever()
PY
REPO_SYNC_CHECKOUT=/tmp/checkout sh /opt/dagster/app/repo-sync.sh &
exec dagster-webserver -h 0.0.0.0 -p 3000 -w /tmp/workspace.yaml
' >/dev/null
for i in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/server_info" >/dev/null 2>&1; then echo "dagster up on $PORT"; exit 0; fi
  sleep 2
done
docker logs --tail 80 "$NAME"
exit 1
