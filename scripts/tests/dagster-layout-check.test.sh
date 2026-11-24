#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# dagster-layout-check.test.sh — WP-49 review N1: the deploy preflight classifies every live domain
# repo read-only, and the post-deploy check fails when the schedule count drops.
# =============================================================================
#   bash scripts/tests/dagster-layout-check.test.sh
#
# Real git bare mirrors built from the generator goldens with images/extensions/dagster/tests/image/
# repo_v2.py: an UNMIGRATED repo shaped like the live ones (v1, dbt at the root, no os/layout.yml,
# with and without os/schedules.yml), a migrated one with its OS-generated module (native), a
# migrated one without a hash record yet (legacy), and a tampered one (refused). kubectl is a fake
# that runs the script's read-only `exec … sh -c` locally against those mirrors.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FIX=os-ui/tabs/data/lib/dbt/fixtures
V2=images/extensions/dagster/tests/image/repo_v2.py
M=$TMP/mirrors; mkdir -p "$M"
mirror() { # <name> <work tree>
  git clone -q --bare "$2" "$M/$1.git"
}
python3 "$V2" "$FIX/ingested-pass-through.golden.json" "$TMP/kiekert" --v1 >/dev/null && mirror kiekert "$TMP/kiekert"
python3 "$V2" "$FIX/append-sync-with-cursor.golden.json" "$TMP/sales" --v1 >/dev/null && mirror sales "$TMP/sales"
python3 "$V2" "$FIX/dlt-lakehouse.golden.json" "$TMP/shop" >/dev/null && mirror shop "$TMP/shop"
python3 "$V2" "$FIX/dlt-lakehouse.golden.json" "$TMP/norec" >/dev/null
git -C "$TMP/norec" rm -q os/generated.yml && git -C "$TMP/norec" -c user.name=t -c user.email=t@t commit -qm "no record" && mirror norec "$TMP/norec"
python3 "$V2" "$FIX/dlt-lakehouse.golden.json" "$TMP/tampered" >/dev/null
printf '\nimport os\n' >> "$TMP/tampered/data/dagster/definitions.py"
git -C "$TMP/tampered" -c user.name=t -c user.email=t@t commit -qam "tamper" && mirror tampered "$TMP/tampered"

BIN=$TMP/bin; mkdir -p "$BIN"
cat > "$BIN/kubectl" <<'EOF'
#!/usr/bin/env bash
# get pods → a pod name; exec … -- sh -c <script> sh <dir> → run it here; exec … python3 → a count
args=("$@")
case " $* " in
  # No pod: real kubectl (seen on a first install, 2026-11-21) prints nothing for `{.items[*]…}`
  # but FAILS a `{.items[0]…}` jsonpath on an empty list — exit 1, "array index out of bounds".
  *" get pods "*)
    if [ -z "${FAKE_NO_POD:-}" ]; then echo "fake-pod"
    else case " $* " in *"{.items[0]"*) echo 'error: error executing jsonpath "{.items[0].metadata.name}": Error executing template: array index out of bounds: index 0, length 0.' >&2; exit 1 ;; esac
    fi ;;
  *" exec "*" sh -c "*)
    for i in "${!args[@]}"; do [ "${args[$i]}" = "-c" ] && [ "${args[$((i-1))]}" = "sh" ] && { shift $((i+1)); break; }; done
    exec sh -c "$1" "${@:2}" ;;
  *" exec "*"python3"*)
    if [ -n "${FAKE_REAL_PY:-}" ]; then  # run the script's real query here, as the pod would
      for i in "${!args[@]}"; do [ "${args[$i]}" = "python3" ] && { shift $((i+1)); break; }; done
      exec python3 "$@"
    fi
    echo "${FAKE_COUNT:-0}" ;;
esac
EOF
chmod +x "$BIN/kubectl"
CHECK="env KUBECTL=$BIN/kubectl DAGSTER_MIRRORS=$M bash scripts/lib/dagster-layout-check.sh"

run() { out=$($CHECK "$@" 2>&1); rc=$?; }

echo "-- layout: all five repos"
run layout ctx ns
printf '%s\n' "$out" | sed 's/^/    /'
check "the live-shaped unmigrated repo is LEGACY (not migrated)" "kiekert: LEGACY (not migrated; schedules from os/schedules.yml (none) + weekly maintenance)" "$out"
check "an unmigrated repo with syncs keeps os/schedules.yml" "sales: LEGACY (not migrated; schedules from os/schedules.yml)" "$out"
check "a migrated repo with its OS-generated module is NATIVE" "shop: NATIVE" "$out"
check "a migrated repo without a hash record is LEGACY" "norec: LEGACY (migrated, no recorded module yet" "$out"
check "a tampered module is REFUSED, with both hashes" "tampered: REFUSED (data/dagster/definitions.py sha256" "$out"
check "summary" "dagster-layout: native=1 legacy=3 refused=1" "$out"
rc_is "NEGATIVE: one refused repo fails the preflight" 1

echo "-- layout: the same repos without the tampered one"
rm -rf "$M/tampered.git"
run layout ctx ns
rc_is "unmigrated and native repos pass the preflight" 0
check "summary" "native=1 legacy=3 refused=0" "$out"

echo "-- layout: no Dagster running yet"
out=$(FAKE_NO_POD=1 $CHECK layout ctx ns 2>&1); rc=$?
rc_is "nothing to check passes, and says so" 0
check "says so" "nothing to check" "$out"

echo "-- schedule count: no Dagster running yet"
out=$(FAKE_NO_POD=1 $CHECK schedules ctx ns 2>&1); rc=$?
rc_is "no webserver counts 0 and passes" 0
check "says so" "counting 0" "$out"

echo "-- schedule count"
out=$(FAKE_COUNT=7 $CHECK schedules ctx ns 2>&1); rc=$?
check "reads the count from the webserver" "7" "$out"
run compare 7 7; rc_is "same count passes" 0
run compare 7 9; rc_is "more schedules pass" 0
run compare 7 6; rc_is "NEGATIVE: a dropped count fails the deploy" 1
check "names the drop" "SCHEDULES_DROPPED" "$out"

echo "-- schedule count: the REAL query against a webserver under /tools/dagster (and the old root)"
# A stand-in webserver: answers the GraphQL count on ONE path ($TMP/gqlpath) and 404 elsewhere,
# exactly as dagster-webserver does with and without --path-prefix. The fake kubectl runs the
# script's python3 here (FAKE_REAL_PY) against it (DAGSTER_WEB_BASE).
python3 - "$TMP" >/dev/null 2>&1 <<'PY' &
import http.server, json, os, sys
tmp = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length") or 0))
        want = open(os.path.join(tmp, "gqlpath")).read().strip()
        if self.path != want:
            self.send_response(404); self.end_headers(); return
        body = json.dumps({"data": {"repositoriesOrError": {"nodes": [{"schedules": [{"name": "a"}, {"name": "b"}]}]}}}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(body)
s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(os.path.join(tmp, "gqlport"), "w").write(str(s.server_port))
s.serve_forever()
PY
GQL_PID=$!; disown "$GQL_PID" 2>/dev/null || true
for _ in $(seq 1 50); do [ -s "$TMP/gqlport" ] && break; sleep 0.1; done
REAL="env FAKE_REAL_PY=1 DAGSTER_WEB_BASE=http://127.0.0.1:$(cat "$TMP/gqlport")"
echo /tools/dagster/graphql > "$TMP/gqlpath"
out=$($REAL $CHECK schedules ctx ns 2>&1); rc=$?
rc_is "a webserver under the prefix is read" 0
check "the count comes from /tools/dagster/graphql" "2" "$out"
echo /graphql > "$TMP/gqlpath"
out=$($REAL $CHECK schedules ctx ns 2>&1); rc=$?
rc_is "an older webserver without the prefix (the count BEFORE that upgrade) is still read" 0
check "the count comes from the root /graphql" "2" "$out"
echo /nowhere > "$TMP/gqlpath"
out=$($REAL $CHECK schedules ctx ns 2>&1); rc=$?
rc_is "NEGATIVE: no path answers — the read FAILS (it is not a count of 0)" 1
absent "NEGATIVE: and prints no number" $'\n0' $'\n'"$out"
kill "$GQL_PID" 2>/dev/null

echo "-- deploy.sh: an unreadable count after the rollout is not reported as SCHEDULES_DROPPED"
check "deploy.sh names an unreadable count" "DAGSTER_SCHEDULES_UNREADABLE_AFTER" "$(cat scripts/deploy.sh)"

echo "-- deploy.sh wiring"
d=$(cat scripts/deploy.sh)
check "deploy.sh runs the layout preflight" "dagster-layout-check.sh layout" "$d"
check "deploy.sh records the count before the upgrade" "DAGSTER_SCHEDULES_BEFORE=\$(bash scripts/lib/dagster-layout-check.sh schedules" "$d"
check "deploy.sh compares after the rollout" "dagster-layout-check.sh compare" "$d"
pre=$(grep -n 'dagster-layout-check.sh layout' scripts/deploy.sh | cut -d: -f1); up=$(grep -n '^helm --kube-context "$CTX" upgrade' scripts/deploy.sh | cut -d: -f1)
holds "the preflight runs before helm upgrade" [ "$pre" -lt "$up" ]
post=$(grep -n 'dagster-layout-check.sh compare' scripts/deploy.sh | cut -d: -f1)
holds "the count check runs after helm upgrade" [ "$post" -gt "$up" ]

finish dagster-layout-check.test
