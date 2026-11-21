#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# dagster-pod-admission.kind.sh — the Dagster run-pod shape, enforced by a real API server.
# =============================================================================
#   bash scripts/tests/dagster-pod-admission.kind.sh [--keep]
#
# Needs docker, kind, kubectl, helm, python3+pyyaml. Creates the kind cluster `$CLUSTER` (default
# `wpdagadm`) at the pinned node image, with its kubeconfig in $KIND_KUBECONFIG (never
# ~/.kube/config); deletes it on exit unless --keep. CHART_DIR overrides the chart (red run).
# Applies the chart's RENDERED policy + binding and the Dagster subchart's own ServiceAccounts,
# Roles and RoleBindings, then writes Pods and Jobs AS those ServiceAccounts (impersonation):
#   1. a run Job and a run Pod in the shape dagster-k8s launches are admitted;
#   2. refused: a Pod or Job labelled as os-ui, an unpinned image, a hostPath volume, a privileged
#      container, another ServiceAccount, and relabelling an existing run pod as os-ui;
#   3. twins: the same forged Pod from a cluster admin is admitted (the policy binds only the
#      Dagster identities), and with the binding deleted the Dagster identity's forged Pod is
#      admitted — so the refusals are the policy's.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
. tests/e2e/kind/versions.env
CLUSTER=${CLUSTER:-wpdagadm}
CHART=${CHART_DIR:-charts/sovereign-agentic-os}
KIND_KUBECONFIG=${KIND_KUBECONFIG:-$(mktemp -d)/kubeconfig}
CTX=kind-$CLUSTER
KEEP=${1:-}
NS=agentic-os
cleanup() { [ "$KEEP" = --keep ] || kind delete cluster --name "$CLUSTER" --kubeconfig "$KIND_KUBECONFIG" >/dev/null 2>&1; }
trap cleanup EXIT
k() { kubectl --kubeconfig "$KIND_KUBECONFIG" --context "$CTX" "$@"; }

if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --kubeconfig "$KIND_KUBECONFIG" --image "$KIND_NODE_IMAGE" || exit 2
fi
k wait --for=condition=Ready node --all --timeout=300s >/dev/null || exit 2
k create namespace "$NS" >/dev/null 2>&1

render=$(mktemp)
helm template agentic-os "$CHART" -n "$NS" --skip-schema-validation > "$render" 2>/dev/null || exit 2
# The policy + binding, and the Dagster subchart's RBAC (ServiceAccounts, Roles, RoleBindings).
python3 - "$render" > "$render.apply" <<'PY' || exit 2
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
keep = [d for d in docs if d['kind'].startswith('ValidatingAdmissionPolicy')
        or (d['kind'] in ('ServiceAccount', 'Role', 'RoleBinding') and 'dagster' in d['metadata']['name'])]
print(yaml.safe_dump_all(keep))
PY
k apply -n "$NS" -f "$render.apply" >/dev/null || exit 2
read -r IMG RUN_SA <<<"$(python3 - "$render" <<'PY'
import sys, yaml, json, re
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
cs = next(d for d in docs if d['kind'] == 'Deployment' and d['spec']['template']['metadata']['labels'].get('app.kubernetes.io/name') == 'dagster-user-deployments')
t = json.dumps(cs['spec']['template']['spec'])
img = re.search(r'\\"image\\": ?\\"([^\\]+)\\"', t) or re.search(r'"image": "([^"]+)"', t)
sa = re.search(r'\\"service_account_name\\": ?\\"([^\\]+)\\"', t)
print(img.group(1), sa.group(1))
PY
)"
rm -f "$render" "$render.apply"
[ -n "$IMG" ] && [ -n "$RUN_SA" ] || { echo "could not read the run image / ServiceAccount from the render" >&2; exit 2; }
DAEMON=system:serviceaccount:$NS:agentic-os-dagster
CODE=system:serviceaccount:$NS:agentic-os-dagster-user-deployments-user-deployments

RUN_LABELS='{"app.kubernetes.io/name":"dagster","app.kubernetes.io/instance":"dagster","app.kubernetes.io/version":"1.13.11","app.kubernetes.io/part-of":"sovereign-os","app.kubernetes.io/component":"run_worker","component":"user-deployments","dagster/run-id":"r-1","dagster/job":"sync"}'
FORGED='{"app.kubernetes.io/name":"os-ui","app.kubernetes.io/instance":"agentic-os","app.kubernetes.io/component":"os-ui"}'
pod() { # pod <name> <labels-json> <image> <sa> [extra-spec-json]
  python3 -c '
import json, sys
name, labels, image, sa = sys.argv[1:5]
extra = json.loads(sys.argv[5]) if len(sys.argv) > 5 else {}
spec = {"serviceAccountName": sa, "restartPolicy": "Never", "containers": [{"name": "dagster", "image": image, "command": ["sleep", "1"]}]}
for k, v in extra.items():
    if k == "container": spec["containers"][0].update(v)
    else: spec[k] = v
print(json.dumps({"apiVersion": "v1", "kind": "Pod", "metadata": {"name": name, "labels": json.loads(labels)}, "spec": spec}))
' "$@"
}
job() { # job <name> <template-labels-json> <image> <sa>
  pod "$1" "$2" "$3" "$4" | python3 -c '
import json, sys
p = json.load(sys.stdin)
print(json.dumps({"apiVersion": "batch/v1", "kind": "Job", "metadata": {"name": p["metadata"]["name"]},
                  "spec": {"backoffLimit": 0, "template": {"metadata": {"labels": p["metadata"]["labels"]}, "spec": p["spec"]}}}))'
}
# write <as> <manifest> [--dry-run=server] — prints the API server's answer; exit = kubectl's.
write() { local who=$1 m=$2; shift 2; local as=(); [ "$who" = admin ] || as=(--as="$who"); echo "$m" | k -n "$NS" create ${as[@]+"${as[@]}"} -f - "$@" 2>&1; }
admitted() { local out; out=$(write "$@") && ok "$LABEL" || bad "$LABEL" "$out"; }
refused() { local want=$1; shift; local out; if out=$(write "$@"); then bad "$LABEL" "admitted: $out"; else check "$LABEL" "$want" "$out"; fi; }

# The API server compiles a new policy asynchronously: wait until it refuses the forged pod.
for _ in $(seq 1 60); do write "$DAEMON" "$(pod probe "$FORGED" "$IMG" "$RUN_SA")" --dry-run=server >/dev/null || break; sleep 2; done

echo "== the run shape dagster-k8s launches is admitted"
LABEL="a run Job from the daemon's ServiceAccount";  admitted "$DAEMON" "$(job run-job "$RUN_LABELS" "$IMG" "$RUN_SA")" --dry-run=server
LABEL="a run Pod from the code location's ServiceAccount"; admitted "$CODE" "$(pod run-pod "$RUN_LABELS" "$IMG" "$RUN_SA")" --dry-run=server
echo "== everything else from a Dagster identity is refused"
LABEL="a Pod labelled as os-ui";        refused "another workload's identity labels" "$DAEMON" "$(pod forged "$FORGED" "$IMG" "$RUN_SA")" --dry-run=server
LABEL="a Job whose pods are labelled as os-ui"; refused "another workload's identity labels" "$DAEMON" "$(job forged-job "$FORGED" "$IMG" "$RUN_SA")" --dry-run=server
LABEL="an extra trusted label (polaris)"; refused "only the run labels" "$CODE" "$(pod extra "$(echo "$RUN_LABELS" | sed 's/}$/,"app.kubernetes.io\/managed-by":"Helm"}/')" "$IMG" "$RUN_SA")" --dry-run=server
LABEL="an unpinned image";              refused "pinned Dagster code-location images" "$DAEMON" "$(pod img "$RUN_LABELS" busybox:1.37.0 "$RUN_SA")" --dry-run=server
LABEL="a hostPath volume";              refused "no hostPath" "$DAEMON" "$(pod hp "$RUN_LABELS" "$IMG" "$RUN_SA" '{"volumes":[{"name":"h","hostPath":{"path":"/"}}]}')" --dry-run=server
LABEL="a privileged container";         refused "no privileged container" "$DAEMON" "$(pod priv "$RUN_LABELS" "$IMG" "$RUN_SA" '{"container":{"securityContext":{"privileged":true}}}')" --dry-run=server
LABEL="host networking";                refused "no host namespace" "$DAEMON" "$(pod hn "$RUN_LABELS" "$IMG" "$RUN_SA" '{"hostNetwork":true}')" --dry-run=server
LABEL="another ServiceAccount";         refused "the run ServiceAccount" "$DAEMON" "$(pod sa "$RUN_LABELS" "$IMG" default)" --dry-run=server
# A real run pod, then an attempt to relabel it as os-ui (Pod UPDATE).
k -n "$NS" create serviceaccount "$RUN_SA" >/dev/null 2>&1
write "$CODE" "$(pod real-run "$RUN_LABELS" "$IMG" "$RUN_SA")" >/dev/null || bad "create a real run pod"
LABEL="relabelling a run pod as os-ui"
if out=$(k -n "$NS" label --as="$CODE" pod real-run --overwrite app.kubernetes.io/component=os-ui 2>&1); then bad "$LABEL" "admitted: $out"; else check "$LABEL" "identity labels" "$out"; fi
echo "== twins"
LABEL="the same forged Pod from a cluster admin is admitted (only Dagster identities are bound)"; admitted admin "$(pod forged-admin "$FORGED" "$IMG" "$RUN_SA")" --dry-run=server
k delete validatingadmissionpolicybinding agentic-os-dagster-run-pod-shape >/dev/null
for _ in $(seq 1 60); do write "$DAEMON" "$(pod probe2 "$FORGED" "$IMG" "$RUN_SA")" --dry-run=server >/dev/null && break; sleep 2; done
LABEL="without the binding the Dagster identity's forged Pod is admitted"; admitted "$DAEMON" "$(pod forged2 "$FORGED" "$IMG" "$RUN_SA")" --dry-run=server
finish dagster-pod-admission.kind
