#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# AT-f eject for AGENT SYSTEMS from the public npm registry (design 11 A17 row d). The unit eject
# (tabs/agents/lib/module/eject.test.ts) links os-ui's node_modules; this one does what an engineer
# leaving the OS does: write the generator golden's committed agent directory into an EMPTY dir,
# `npm ci` from its own package-lock.json in a bare node image, and `node run.mjs --stub-tools`
# against an OpenAI-compatible stub. No OS module, no OS image, no OS_* variable.
#   agents-registry.sh <work-dir>
# NEGATIVE TWIN: the same directory with an OS import added to graph.mjs fails to run.
set -euo pipefail
WORK="$1"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GOLDEN="$REPO_ROOT/os-ui/tabs/agents/lib/module/fixtures/revenue-review.golden.json"
DOCKERFILE="$REPO_ROOT/images/extensions/dagster/Dockerfile"
die() { echo "FAIL $*"; exit 1; }
# node:22-slim, pinned by digest (multi-arch index, resolved 2026-11-21).
NODE_IMAGE="node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee"
# The stub runs on the same digest-pinned python base the Dagster image uses.
PY_IMAGE="$(awk '/^FROM /{print $2; exit}' "$DOCKERFILE")"
case "$PY_IMAGE" in *@sha256:*) ;; *) die "Dockerfile base is not pinned by digest: '$PY_IMAGE'";; esac
NET="agents-eject-$$"; STUB="agents-eject-stub-$$"
cleanup() { docker rm -f "$STUB" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT

mkdir -p "$WORK/ws"
python3 - "$GOLDEN" "$WORK/ws" <<'PY'
import json, os, sys
for p, c in json.load(open(sys.argv[1])).items():
    f = os.path.join(sys.argv[2], p); os.makedirs(os.path.dirname(f), exist_ok=True); open(f, 'w').write(c)
PY
dirs=("$WORK"/ws/agents/*/)
[ "${#dirs[@]}" -eq 1 ] && [ -d "${dirs[0]}" ] || die "expected exactly one agent directory in the golden"
DIR="${dirs[0]%/}"; SLUG="$(basename "$DIR")"
[ -f "$DIR/package-lock.json" ] || die "no package-lock.json committed"
if grep -nE "@core/|@tabs/|sovereign" "$DIR/graph.mjs" "$DIR/run.mjs"; then die "an OS import in the native module"; fi
cp "$(dirname "$0")/stub_openai.py" "$WORK/stub_openai.py"
chmod -R a+rwX "$WORK"

docker network create "$NET" >/dev/null
docker run -d --name "$STUB" --network "$NET" -v "$WORK:/w:ro" "$PY_IMAGE" python3 /w/stub_openai.py >/dev/null
run() {
  docker run --rm --network "$NET" -v "$WORK/ws:/ws" -w "/ws/agents/$SLUG" -e HOME=/tmp \
    -e OPENAI_BASE_URL="http://$STUB:8000/v1" -e OPENAI_API_KEY=stub -e OPENAI_MODEL=stub "$NODE_IMAGE" bash -c "set -euo pipefail; $1"
}
run 'npm ci --no-audit --no-fund >/tmp/npm.log 2>&1 || { tail -20 /tmp/npm.log; exit 1; }; if env | grep -q "^OS_"; then echo "an OS_ variable is set"; exit 1; fi'
echo "ok   npm ci from the committed package-lock.json"
out="$(run 'node run.mjs --stub-tools --input "Review Q3 revenue" --json')"
echo "$out" | tail -3
grep -q '"nodes":\["agent_lead"' <<< "$out" || die "node run.mjs did not reach the lead agent"
echo "ok   node run.mjs --stub-tools reached END from a registry install"

# NEGATIVE TWIN: an OS import in graph.mjs must make the ejected module unrunnable.
{ echo 'import "@core/kernel/config";'; cat "$DIR/graph.mjs"; } > "$DIR/graph.mjs.twin"
mv "$DIR/graph.mjs.twin" "$DIR/graph.mjs"
if run 'node run.mjs --stub-tools --input x --json' >"$WORK/twin.log" 2>&1; then die "negative twin ran"; fi
# Node names the missing PACKAGE ('@core/kernel'), not the subpath.
grep -q "ERR_MODULE_NOT_FOUND" "$WORK/twin.log" && grep -q "'@core/" "$WORK/twin.log" || { tail -12 "$WORK/twin.log"; die "negative twin failed for another reason"; }
echo "ok   negative twin: graph.mjs importing @core/ does not run"
echo "agents registry eject: ok"
