#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# AT-f eject for AGENT SYSTEMS from the public npm registry (design 11 A17 row d). The unit eject
# (tabs/agents/lib/module/eject.test.ts) links os-ui's node_modules; this one does what an engineer
# leaving the OS does: write the generator golden's committed agent directory into an EMPTY dir,
# `npm ci` from its own package-lock.json in a bare node image, and `node run.mjs --stub-tools`
# against an OpenAI-compatible stub. No OS module, no OS image, no OS env.
#   agents-registry.sh <work-dir>
# NEGATIVE TWIN: the same directory with an OS import added to graph.mjs fails to run.
set -eu
WORK="$1"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GOLDEN="$REPO_ROOT/os-ui/tabs/agents/lib/module/fixtures/revenue-review.golden.json"
NODE_IMAGE="node:22-slim"; PY_IMAGE="python:3.12-slim"
NET="agents-eject-$$"; STUB="agents-eject-stub-$$"
cleanup() { docker rm -f "$STUB" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
mkdir -p "$WORK/ws"
python3 - "$GOLDEN" "$WORK/ws" <<'PY'
import json, os, sys
for p, c in json.load(open(sys.argv[1])).items():
    f = os.path.join(sys.argv[2], p); os.makedirs(os.path.dirname(f), exist_ok=True); open(f, 'w').write(c)
PY
DIR="$(ls -d "$WORK"/ws/agents/*/ | head -1)"; SLUG="$(basename "$DIR")"
test -f "$DIR/package-lock.json" || { echo "FAIL no package-lock.json committed"; exit 1; }
if grep -nE "@core/|@tabs/|sovereign" "$DIR/graph.mjs" "$DIR/run.mjs"; then echo "FAIL an OS import in the native module"; exit 1; fi
cp "$(dirname "$0")/stub_openai.py" "$WORK/stub_openai.py"
chmod -R a+rwX "$WORK"
docker network create "$NET" >/dev/null
docker run -d --name "$STUB" --network "$NET" -v "$WORK:/w:ro" "$PY_IMAGE" python3 /w/stub_openai.py >/dev/null
run() {
  docker run --rm --network "$NET" -v "$WORK/ws:/ws" -w "/ws/agents/$SLUG" -e HOME=/tmp \
    -e OPENAI_BASE_URL="http://$STUB:8000/v1" -e OPENAI_API_KEY=stub -e OPENAI_MODEL=stub "$NODE_IMAGE" sh -c "$1"
}
out="$(run 'npm ci --no-audit --no-fund >/dev/null 2>&1 && env | grep -q "^OS_" && exit 9; node run.mjs --stub-tools --input "Review Q3 revenue" --json')"
echo "$out" | tail -3
echo "$out" | grep -q '"nodes":\["agent_lead"' && echo "ok   node run.mjs --stub-tools reached END from a registry install" || { echo "FAIL run"; exit 1; }
# NEGATIVE TWIN: an OS import in graph.mjs must make the ejected module unrunnable.
{ echo 'import "@core/kernel/config";'; cat "$DIR/graph.mjs"; } > "$DIR/graph.mjs.twin" && mv "$DIR/graph.mjs.twin" "$DIR/graph.mjs"
if run 'node run.mjs --stub-tools --input x --json' >/dev/null 2>&1; then echo "FAIL negative twin ran"; exit 1; fi
echo "ok   negative twin: graph.mjs importing @core/ does not run"
echo "agents registry eject: ok"
