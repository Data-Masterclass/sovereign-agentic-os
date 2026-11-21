#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
#
# The `sovereign` code location picks up a domain commit WITHOUT a pod restart.
#   code-server-reload.sh <dagster image> [code-server|api-grpc]
#
# WHY. repo-sync repoints /repos-checkout/<domain>/current after `dbt parse` and then calls the
# webserver's `reloadRepositoryLocation` (images/extensions/dagster/repo-sync.sh). Dagster reloads a
# location's definitions only when its server was started with `dagster code-server start`. A server
# started with `dagster api grpc` logs "Reloading definitions from a code server launched via
# `dagster api grpc` without restarting the process is not currently supported" and keeps what it
# loaded at boot (the Dagster Helm chart, dagster-user-deployments/values.yaml: "`codeServerArgs`
# ... can reload its definitions from within the Dagster UI without needing to restart the user
# code deployment pod"). On dev the server booted before repo-sync's first verdict, so it kept
# "no validated commit yet" for every domain: no domain assets, no schedules, no runs.
#
# The test is the real hop, in the image: the platform wrapper repo.py served by the chosen server
# command, the real dagster-webserver in front of it, an EMPTY checkout at boot, then the domain
# commit placed as repo-sync places it (`os_projects.py --parse`, then the `current` symlink) and
# the GraphQL mutation repo-sync sends.
#   code-server (the chart's mode): after the reload the domain's assets and schedule are there.
#   api-grpc    (NEGATIVE TWIN, the old mode): after the same reload they are still missing.
set -eu
IMAGE="${1:?usage: code-server-reload.sh <dagster image> [code-server|api-grpc]}"
MODE="${2:-code-server}"
REPO="$(cd "$(dirname "$0")/../../../../.." && pwd)"
HERE="$REPO/images/extensions/dagster/tests/image"
GOLDEN="$REPO/os-ui/tabs/data/lib/dbt/fixtures/dlt-lakehouse.golden.json"
# Under $HOME: a VM-backed docker (colima) shares the home directory, not macOS's temp dir.
mkdir -p "${LAKEHOUSE_TMP:-$HOME/.cache/lakehouse}"
WORK="$(mktemp -d "${LAKEHOUSE_TMP:-$HOME/.cache/lakehouse}/reload.XXXXXX")"
NAME="code-server-reload-$$"
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || docker run --rm -v "$WORK:/w" alpine sh -c 'rm -rf /w/*' >/dev/null 2>&1 || true
}
trap cleanup EXIT

case $MODE in
  code-server) SERVER="dagster code-server start -h 127.0.0.1 -p 3030 -f /opt/dagster/app/repo.py" ;;
  api-grpc)    SERVER="dagster api grpc -h 127.0.0.1 -p 3030 --python-file /opt/dagster/app/repo.py" ;;
  *) echo "mode must be code-server or api-grpc"; exit 2 ;;
esac

SHA="$(python3 "$HERE/repo_v2.py" "$GOLDEN" "$WORK/origin")"
mkdir -p "$WORK/checkout"
cat > "$WORK/workspace.yaml" <<'YAML'
load_from:
  - grpc_server: { host: 127.0.0.1, port: 3030, location_name: sovereign }
YAML
chmod -R a+rwX "$WORK"

# One container, no network: the code server and the webserver, as the chart runs them in two pods.
docker run -d --name "$NAME" --network none -v "$WORK:/w" -w /opt/dagster/app \
  -e HOME=/tmp -e DAGSTER_HOME=/tmp/dh -e REPO_SYNC_CHECKOUT=/w/checkout -e DBT_SEND_ANONYMOUS_USAGE_STATS=false \
  "$IMAGE" sh -c "mkdir -p /tmp/dh && ($SERVER >/tmp/server.log 2>&1 &) && exec dagster-webserver -h 127.0.0.1 -p 3070 -w /w/workspace.yaml >/tmp/web.log 2>&1" >/dev/null

gql() { docker exec -i "$NAME" python3 - "$1" <<'PY'
import json, sys, time, urllib.request
step = sys.argv[1]
URL = "http://127.0.0.1:3070/graphql"
def call(q, v=None):
    body = json.dumps({"query": q, "variables": v or {}}).encode()
    return json.load(urllib.request.urlopen(urllib.request.Request(URL, body, {"content-type": "application/json"}), timeout=60))
READ = "{ assetNodes { assetKey { path } } repositoriesOrError { ... on RepositoryConnection { nodes { schedules { name } } } } }"
def state():
    r = call(READ)["data"]
    assets = sorted("/".join(n["assetKey"]["path"]) for n in r["assetNodes"])
    sched = sorted(s["name"] for n in (r["repositoriesOrError"].get("nodes") or []) for s in n["schedules"])
    return assets, sched
if step == "boot":
    for _ in range(120):
        try:
            a, s = state()
            if call("{ repositoriesOrError { __typename } }")["data"]["repositoriesOrError"]["__typename"] == "RepositoryConnection":
                break
        except Exception:
            pass
        time.sleep(2)
    else:
        raise SystemExit("webserver did not load the location")
else:
    # The exact mutation repo-sync sends (images/extensions/dagster/repo-sync.sh).
    r = call("mutation($n: String!) { reloadRepositoryLocation(repositoryLocationName: $n) { __typename } }", {"n": "sovereign"})
    print("mutation", r["data"]["reloadRepositoryLocation"]["__typename"])
    for _ in range(30):
        time.sleep(2)
        try:
            a, s = state()
        except Exception:
            continue
        if any(x.startswith("sales/") for x in a):
            break
a = [x for x in a if x.startswith("sales/")]
s = [x for x in s if x.startswith("sales__")]
print(step, "sales_assets", len(a), "sales_schedules", len(s), s)
PY
}

boot="$(gql boot)"; echo "$boot"
# The domain commit, placed as repo-sync places it: parsed by the image, then `current` repointed.
git clone -q "$WORK/origin" "$WORK/checkout/sales/$SHA"
chmod -R a+rwX "$WORK/checkout"
docker exec "$NAME" python3 /opt/dagster/app/os_projects.py --parse "/w/checkout/sales/$SHA" >/dev/null
ln -s "$SHA" "$WORK/checkout/sales/current"
after="$(gql reload)"; echo "$after"
docker exec "$NAME" sh -c 'grep -h "not currently supported" /tmp/server.log /tmp/web.log 2>/dev/null | head -1 | cut -c1-200' || true

n_boot="$(echo "$boot" | sed -n 's/^boot sales_assets \([0-9]*\).*/\1/p')"
n_after="$(echo "$after" | sed -n 's/^reload sales_assets \([0-9]*\) sales_schedules \([0-9]*\).*/\1 \2/p')"
set -- $n_after
[ "${n_boot:-x}" = 0 ] || { echo "FAIL boot: expected 0 sales assets before the commit (got ${n_boot:-none})"; exit 1; }
if [ "$MODE" = code-server ]; then
  if [ "${1:-0}" -gt 0 ] && [ "${2:-0}" -gt 0 ]; then echo "CODE_SERVER_RELOAD_OK: $1 asset(s), $2 schedule(s) after one reload"; exit 0; fi
  echo "FAIL code-server: the reload did not pick up the domain commit"; docker exec "$NAME" tail -30 /tmp/server.log; exit 1
fi
if [ "${1:-0}" = 0 ]; then echo "API_GRPC_STALE_AS_EXPECTED: the reload kept the boot definitions (negative twin)"; exit 0; fi
echo "FAIL negative twin: api grpc picked up the commit, so this test does not tell the modes apart"; exit 1
