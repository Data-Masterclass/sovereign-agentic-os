#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# dagster-launcher-lockdown.kind.sh — the REAL Dagster (vendored subchart 1.13.11, the image built
# from this checkout) on kind: runs launched through the webserver's own GraphQL `launchRun`.
# =============================================================================
#   bash scripts/tests/dagster-launcher-lockdown.kind.sh [dagster image]
#   (needs docker, kind, kubectl, helm, curl, python3 + pyyaml; image default sovereign-os/dagster:lock)
#   LOCK_KIND_NAME (default wp15lock), LOCK_KUBECONFIG (default: a temp file — never ~/.kube/config),
#   LOCK_KEEP=1 keeps the cluster.
#
# The Dagster values are the chart's own `dagster:` block (STOCK) and that block with
# values.dagster-launcher-lockdown.yaml merged on top (LOCK-DOWN, Helm's merge: maps merge, lists
# replace). Only what kind cannot have is swapped, the same way in both: the private image for one
# built FROM this checkout's image plus a one-op code location, and `pg-rw` is a postgres:17 Pod.
# Both get the same OPERATOR run_k8s_config additions WP-15's overlay makes (one env entry, one
# volume + mount), at the place each launcher reads them.
#
#   STOCK      i.   a normal OS run (tag env OS_PINNED_COMMITS, OS_PRINCIPAL + PYTHONPATH) -> SUCCESS
#              ii.  a tag setting container_config.image/command, pod_spec_config.volumes (hostPath)
#                   and .service_account_name -> a Job IS created with that spec (the twin)
#              iii. PYTHONPATH from the tag IS in the run pod (the twin)
#   LOCK-DOWN  i.   the same normal run -> SUCCESS; its Job spec equals the stock one (but PYTHONPATH)
#              ii.  each of the four tags alone -> the run fails "violated the allowed list", no Job
#              iii. PYTHONPATH is NOT in the run pod; the operator env + volume ARE
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
# shellcheck source=scripts/tests/assert.sh
. scripts/tests/assert.sh
for b in docker kind kubectl helm curl python3; do command -v "$b" >/dev/null || { echo "$b not on PATH"; exit 2; }; done
python3 -c 'import yaml' 2>/dev/null || { echo "python3 needs pyyaml"; exit 2; }
BASE_IMAGE=${1:-${DAGSTER_LOCK_IMAGE:-sovereign-os/dagster:lock}}
NAME=${LOCK_KIND_NAME:-wp15lock}
NS=agentic-os
TGZ=charts/sovereign-agentic-os/charts/dagster-1.13.11.tgz
[ -f "$TGZ" ] || { echo "no $TGZ (helm dependency build charts/sovereign-agentic-os)"; exit 2; }
TEST_IMAGE=sovereign-os/dagster-lockdown-test:kind
TMP=$(mktemp -d)
export KUBECONFIG=${LOCK_KUBECONFIG:-$TMP/kubeconfig}
PF_PID=""
cleanup() {
  [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null
  [ -n "${LOCK_KEEP:-}" ] || kind delete cluster --name "$NAME" --kubeconfig "$KUBECONFIG" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT
K() { kubectl --context "kind-$NAME" -n "$NS" "$@"; }

# ── the code location: one op that does nothing, in an image built FROM this checkout's image ──
mkdir -p "$TMP/img"
cat > "$TMP/img/wp15lock_defs.py" <<'EOF'
from dagster import Definitions, job, op


@op
def probe(context):
    context.log.info("wp15lock run pod")


@job
def wp15lock_job():
    probe()


defs = Definitions(jobs=[wp15lock_job])
EOF
printf 'FROM %s\nCOPY wp15lock_defs.py /opt/dagster/app/wp15lock_defs.py\n' "$BASE_IMAGE" > "$TMP/img/Dockerfile"
docker build -q -t "$TEST_IMAGE" "$TMP/img" >/dev/null || { echo "test image build failed"; exit 2; }

# ── the two value sets, from the chart's own values and the overlay ──
gen() {  # $1 stock|lock
  python3 - "$1" "$TEST_IMAGE" > "$TMP/$1.values.yaml" <<'EOF'
import sys, yaml
mode, image = sys.argv[1], sys.argv[2]
repo, tag = image.rsplit(":", 1)
def merge(a, b):  # Helm's values merge: maps merge, everything else (lists too) replaces
    if isinstance(a, dict) and isinstance(b, dict):
        return {**a, **{k: merge(a.get(k), v) if k in a else v for k, v in b.items()}}
    return b
v = yaml.safe_load(open("charts/sovereign-agentic-os/values.yaml"))["dagster"]
if mode == "lock":
    v = merge(v, yaml.safe_load(open("values.dagster-launcher-lockdown.yaml"))["dagster"])
for k in ("enabled", "postgresPasswordLocal"):
    v.pop(k, None)
PRIVATE = "ghcr.io/data-masterclass/sovereign-os/dagster"
def swap(x):
    if isinstance(x, dict):
        if x.get("repository") == PRIVATE:
            x = {**x, "repository": repo, "tag": tag, "pullPolicy": "IfNotPresent"}
            x.pop("digest", None)
        return {k: swap(val) for k, val in x.items()}
    if isinstance(x, list):
        return [swap(i) for i in x]
    if isinstance(x, str) and x.startswith(PRIVATE + ":"):
        return image
    return x
v = swap(v)
for d in v["dagster-user-deployments"]["deployments"]:
    d["dagsterApiGrpcArgs"] = ["--python-file", "/opt/dagster/app/wp15lock_defs.py"]
# The OPERATOR additions WP-15 makes (values.dagster-run-identity.yaml): env + volume + mount.
env = {"name": "WP15LOCK_OPERATOR_ENV", "value": "from-the-operator"}
vol = {"name": "wp15lock-operator", "emptyDir": {}}
mnt = {"name": "wp15lock-operator", "mountPath": "/var/run/wp15lock"}
if mode == "stock":
    rk = v["runLauncher"]["config"]["k8sRunLauncher"]["runK8sConfig"]
    rk.setdefault("containerConfig", {}).setdefault("env", []).append(env)
    rk["containerConfig"].setdefault("volumeMounts", []).append(mnt)
    rk.setdefault("podSpecConfig", {}).setdefault("volumes", []).append(vol)
else:
    rk = v["runLauncher"]["config"]["customRunLauncher"]["config"]["run_k8s_config"]
    rk["container_config"]["env"].append(env)
    rk["container_config"]["volume_mounts"].append(mnt)
    rk["pod_spec_config"]["volumes"].append(vol)
yaml.safe_dump(v, sys.stdout, sort_keys=False)
EOF
}
gen stock || exit 2
if [ -f values.dagster-launcher-lockdown.yaml ]; then gen lock || exit 2; fi

# ── the cluster ──
kind create cluster --name "$NAME" --kubeconfig "$KUBECONFIG" --wait 120s >/dev/null || { echo "kind create failed"; exit 2; }
kind load docker-image "$TEST_IMAGE" --name "$NAME" >/dev/null || { echo "kind load failed"; exit 2; }
K create namespace "$NS" >/dev/null 2>&1 || kubectl --context "kind-$NAME" create namespace "$NS" >/dev/null
PGPW=wp15lock-throwaway
K create secret generic dagster-postgresql --from-literal=postgresql-password=$PGPW >/dev/null
K create secret generic agent-runtime-token --from-literal=token=wp15lock-throwaway >/dev/null
K apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata: { name: pg, labels: { app: pg } }
spec:
  containers:
    - name: postgres
      image: postgres:17@sha256:5c855ad7b85e68e48a62f34662853f38b57c1c1d80f3a927ab58034fd6d31c5e
      env:
        - { name: POSTGRES_USER, value: dagster }
        - { name: POSTGRES_DB, value: dagster }
        - { name: POSTGRES_PASSWORD, value: $PGPW }
      ports: [{ containerPort: 5432 }]
      readinessProbe: { exec: { command: [pg_isready, -U, dagster] }, periodSeconds: 2 }
---
apiVersion: v1
kind: Service
metadata: { name: pg-rw }
spec: { selector: { app: pg }, ports: [{ port: 5432 }] }
EOF
K wait --for=condition=Ready pod/pg --timeout=300s >/dev/null || { echo "postgres not ready"; exit 2; }

GQLURL=http://127.0.0.1:${LOCK_PORT:-3071}/graphql
gql() {  # $1 query, $2 variables JSON -> response on stdout
  python3 -c 'import json,sys; print(json.dumps({"query": sys.argv[1], "variables": json.loads(sys.argv[2])}))' "$1" "${2:-{\}}" \
    | curl -s --max-time 30 "$GQLURL" -H 'content-type: application/json' -d @-
}
install() {  # $1 stock|lock
  [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null
  helm upgrade --install agentic-os "$TGZ" --kube-context "kind-$NAME" -n "$NS" -f "$TMP/$1.values.yaml" \
    --wait --timeout 10m >"$TMP/helm.log" 2>&1 || { cat "$TMP/helm.log"; K get pods; return 1; }
  K rollout status deploy/agentic-os-dagster-webserver --timeout=300s >/dev/null
  K rollout status deploy/agentic-os-dagster-daemon --timeout=300s >/dev/null
  K rollout status deploy/agentic-os-dagster-user-deployments-sovereign --timeout=300s >/dev/null
  K port-forward svc/agentic-os-dagster-webserver "${LOCK_PORT:-3071}:80" >/dev/null 2>&1 &
  PF_PID=$!
  for _ in $(seq 1 90); do  # the webserver has loaded the `sovereign` location and its job
    gql '{ pipelineOrError(params: {repositoryLocationName: "sovereign", repositoryName: "__repository__", pipelineName: "wp15lock_job"}) { __typename } }' \
      2>/dev/null | grep -q '"Pipeline"' && return 0
    sleep 2
  done
  echo "the code location never loaded"; gql '{ workspaceOrError { ... on Workspace { locationEntries { name locationOrLoadError { __typename ... on PythonError { message } } } } } }'
  return 1
}
LAUNCH='mutation($p: ExecutionParams!) { launchRun(executionParams: $p) { __typename ... on LaunchRunSuccess { run { runId } } ... on PythonError { message } } }'
launch() {  # $1 = dagster-k8s/config tag JSON -> run id on stdout
  local vars
  vars=$(python3 -c 'import json,sys; print(json.dumps({"p": {"selector": {"repositoryLocationName": "sovereign", "repositoryName": "__repository__", "jobName": "wp15lock_job"}, "executionMetadata": {"tags": [{"key": "dagster-k8s/config", "value": sys.argv[1]}]}}}))' "$1")
  gql "$LAUNCH" "$vars" | python3 -c 'import json,sys; r=json.load(sys.stdin)["data"]["launchRun"]; print(r["run"]["runId"] if r["__typename"]=="LaunchRunSuccess" else "ERR:"+json.dumps(r))'
}
status() { gql 'query($id: ID!) { runOrError(runId: $id) { ... on Run { status } } }' "{\"id\":\"$1\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["runOrError"].get("status",""))'; }
wait_final() {  # $1 run id; prints final status
  local s=""
  for _ in $(seq 1 150); do
    s=$(status "$1"); case $s in SUCCESS|FAILURE|CANCELED) echo "$s"; return;; esac; sleep 2
  done
  echo "TIMEOUT($s)"
}
wait_job() {  # $1 run id -> 0 when a Job exists
  for _ in $(seq 1 60); do [ -n "$(K get jobs -l "dagster/run-id=$1" -o name 2>/dev/null)" ] && return 0; sleep 2; done; return 1
}
job_json() { K get jobs -l "dagster/run-id=$1" -o json | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["items"][0]))'; }
events() { gql 'query($id: ID!) { logsForRun(runId: $id) { ... on EventConnection { events { __typename ... on MessageEvent { message } ... on EngineEvent { error { message } } ... on RunFailureEvent { error { message } } } } } }' "{\"id\":\"$1\"}"; }
spec_of() {  # Job JSON on stdin -> the run pod template, normalised for a stock/lock-down compare
  python3 -c '
import json,sys
j=json.load(sys.stdin); t=j["spec"]["template"]
labels={k:v for k,v in t["metadata"].get("labels",{}).items() if k!="dagster/run-id"}
s=t["spec"]; c=s["containers"][0]; c.pop("args",None)
c["env"]=sorted([e for e in c.get("env",[]) if e["name"]!="PYTHONPATH"], key=lambda e:e["name"])
for k in ("volumeMounts",): c[k]=sorted(c.get(k,[]), key=lambda e:e["name"])
s["volumes"]=sorted(s.get("volumes",[]), key=lambda e:e["name"])
print(json.dumps({"labels":labels,"spec":s}, sort_keys=True))'
}
envnames() { python3 -c 'import json,sys; print(" ".join(e["name"] for e in json.load(sys.stdin)["spec"]["template"]["spec"]["containers"][0].get("env",[])))'; }

NORMAL='{"container_config":{"env":[{"name":"OS_PINNED_COMMITS","value":"sales=0123456789abcdef0123456789abcdef01234567"},{"name":"OS_PRINCIPAL","value":"alice"},{"name":"PYTHONPATH","value":"/tmp/wp15lock-not-allowed"}]}}'
T_IMAGE='{"container_config":{"image":"busybox:1.36"}}'
T_COMMAND='{"container_config":{"command":["/bin/sh","-c","true"]}}'
T_VOLUME='{"pod_spec_config":{"volumes":[{"name":"host","host_path":{"path":"/"}}]}}'
T_SA='{"pod_spec_config":{"service_account_name":"default"}}'
T_ALL='{"container_config":{"image":"busybox:1.36","command":["/bin/sh","-c","true"]},"pod_spec_config":{"volumes":[{"name":"host","host_path":{"path":"/"}}],"service_account_name":"default"}}'

echo "STOCK launcher (no overlay) — the twin"
install stock || { bad "stock install"; finish dagster-launcher-lockdown.kind; exit 1; }
rid=$(launch "$NORMAL"); case $rid in ERR:*) bad "stock i. launchRun" "$rid";; esac
st=$(wait_final "$rid")
check "stock i. a normal OS run succeeds" "SUCCESS" "$st"
STOCK_SPEC=""
if wait_job "$rid"; then
  STOCK_SPEC=$(job_json "$rid" | spec_of)
  names=$(job_json "$rid" | envnames)
  check "stock iii. (twin) PYTHONPATH from the tag IS in the run pod" "PYTHONPATH" "$names"
  check "stock: the operator env (WP-15-style) reaches the run pod" "WP15LOCK_OPERATOR_ENV" "$names"
else bad "stock i. a Job was created"; fi
rid=$(launch "$T_ALL")
if wait_job "$rid"; then
  j=$(job_json "$rid")
  check "stock ii. (twin) the tag's image is the run container's" '"image": "busybox:1.36"' "$(echo "$j" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["spec"]["template"]["spec"]["containers"][0]))')"
  check "stock ii. (twin) the tag's hostPath volume is in the pod" '"hostPath": {"path": "/"' "$j"
  check "stock ii. (twin) the tag's service account is the pod's" '"serviceAccountName": "default"' "$j"
  check "stock ii. (twin) the tag's command is the container's" '"command": ["/bin/sh", "-c", "true"]' "$j"
  K delete jobs -l "dagster/run-id=$rid" --wait=false >/dev/null 2>&1
else bad "stock ii. (twin) a Job is created for the tag" "$(events "$rid" | head -c 800)"; fi

if [ ! -f values.dagster-launcher-lockdown.yaml ]; then
  bad "LOCK-DOWN: values.dagster-launcher-lockdown.yaml exists"; finish dagster-launcher-lockdown.kind; exit 1
fi
echo "LOCK-DOWN launcher (values.dagster-launcher-lockdown.yaml)"
install lock || { bad "lock-down install"; finish dagster-launcher-lockdown.kind; exit 1; }
rid=$(launch "$NORMAL"); case $rid in ERR:*) bad "lock i. launchRun" "$rid";; esac
st=$(wait_final "$rid")
check "lock i. a normal OS run succeeds" "SUCCESS" "$st"
if wait_job "$rid"; then
  j=$(job_json "$rid"); names=$(echo "$j" | envnames)
  absent "lock iii. PYTHONPATH from the tag is NOT in the run pod" "PYTHONPATH" "$names"
  check "lock: OS_PINNED_COMMITS from the tag reaches the run pod" "OS_PINNED_COMMITS" "$names"
  check "lock: OS_PRINCIPAL from the tag reaches the run pod" "OS_PRINCIPAL" "$names"
  check "lock: the operator env (WP-15-style) reaches the run pod" "WP15LOCK_OPERATOR_ENV" "$names"
  check "lock: the operator volume (WP-15-style) is in the run pod" '"name": "wp15lock-operator"' "$j"
  check "lock: the image is the code location's (DAGSTER_CURRENT_IMAGE)" "\"image\": \"$TEST_IMAGE\"" "$j"
  LOCK_SPEC=$(echo "$j" | spec_of)
  if [ -n "$STOCK_SPEC" ] && [ "$STOCK_SPEC" = "$LOCK_SPEC" ]; then ok "lock i. the run pod spec equals the stock one (but PYTHONPATH)"
  else bad "lock i. the run pod spec equals the stock one (but PYTHONPATH)" "$(python3 -c '
import json,sys
a,b=json.loads(sys.argv[1] or "{}"),json.loads(sys.argv[2])
def d(x,y,p=""):
    if isinstance(x,dict) and isinstance(y,dict):
        for k in set(x)|set(y):
            if x.get(k)!=y.get(k): d(x.get(k),y.get(k),p+"."+k)
    else: print(p, json.dumps(x)[:300], "|", json.dumps(y)[:300])
d(a,b)' "$STOCK_SPEC" "$LOCK_SPEC")"; fi
else bad "lock i. a Job was created" "$(events "$rid" | head -c 800)"; fi
for t in "container_config.image:$T_IMAGE" "container_config.command:$T_COMMAND" \
         "pod_spec_config.volumes:$T_VOLUME" "pod_spec_config.service_account_name:$T_SA"; do
  field=${t%%:*}; tag=${t#*:}
  rid=$(launch "$tag")
  st=$(wait_final "$rid")
  check "lock ii. a tag setting $field: the run fails" "FAILURE" "$st"
  check "lock ii. ... refused by the launcher (\"violated the allowed list: $field\")" "violated the allowed list: $field" "$(events "$rid")"
  n=$(K get jobs -l "dagster/run-id=$rid" -o name 2>/dev/null | wc -l | tr -d ' ')
  check "lock ii. ... and no Job was created" "0" "$n"
done
finish dagster-launcher-lockdown.kind
