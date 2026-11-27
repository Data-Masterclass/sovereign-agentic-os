#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# scanner-admission.kind.sh — the software scanner's own namespace, enforced by a real API server.
# =============================================================================
#   bash scripts/tests/scanner-admission.kind.sh [--keep]
#
# Needs docker, kind, kubectl, helm, node (+ `npm --prefix os-ui ci`), python3+pyyaml. Creates the
# kind cluster `$CLUSTER` (default `wpscanadm`) at kind's default node image (KIND_NODE_IMAGE overrides;
# CI: the "Chart guards (kind)" step), with its kubeconfig in
# $KIND_KUBECONFIG (never ~/.kube/config); deletes it on exit unless --keep. CHART_DIR overrides the
# chart (red run).
# Applies the chart's RENDERED scanner namespace, os-ui's Role/RoleBinding there, the admission policy
# + binding and the NetworkPolicies, then writes AS os-ui (impersonation) the Job and payload Secret
# os-ui's OWN code builds (os-ui/scripts/print-scan-job.ts):
#   1. the real scan Job, its payload Secret, and the Pod the Job controller would make are admitted;
#   2. refused: a Job that mounts another Secret, envFrom a Secret, env secretKeyRef, a projected
#      ServiceAccount token, an automounted token, an unpinned image, a hostPath, host networking, a
#      privileged or root container, no requests/limits, parallelism/completions/retries, a priorityClassName,
#      a writable payload, an init container; a Secret of
#      type ServiceAccount token or with another name;
#   3. RBAC: os-ui cannot get/list Secrets in the scanner namespace;
#   4. Pod Security `restricted` is enforced on the namespace;
#   5. twin: with the binding deleted, os-ui's Secret-mounting Job is admitted — so the refusals are
#      the policy's.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
CLUSTER=${CLUSTER:-wpscanadm}
CHART=${CHART_DIR:-charts/sovereign-agentic-os}
KIND_KUBECONFIG=${KIND_KUBECONFIG:-$(mktemp -d)/kubeconfig}
CTX=kind-$CLUSTER
KEEP=${1:-}
REL=agentic-os
cleanup() { [ "$KEEP" = --keep ] || kind delete cluster --name "$CLUSTER" --kubeconfig "$KIND_KUBECONFIG" >/dev/null 2>&1; }
trap cleanup EXIT
k() { kubectl --kubeconfig "$KIND_KUBECONFIG" --context "$CTX" "$@"; }

if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --kubeconfig "$KIND_KUBECONFIG" ${KIND_NODE_IMAGE:+--image "$KIND_NODE_IMAGE"} --wait 120s || exit 2
fi
k wait --for=condition=Ready node --all --timeout=300s >/dev/null || exit 2
k create namespace "$REL" >/dev/null 2>&1
k -n "$REL" create serviceaccount os-ui >/dev/null 2>&1
k -n "$REL" create serviceaccount os-ui-worker >/dev/null 2>&1

render=$(mktemp)
helm template "$REL" "$CHART" -n "$REL" --skip-schema-validation --set global.allowChartDefaultSecrets=true \
  --set osUI.worker.enabled=true --show-only templates/base/os-ui/software-scanner.yaml > "$render" 2>/dev/null || { echo "render failed" >&2; exit 2; }
read -r NS IMG <<<"$(python3 - "$render" <<'PY'
import sys, yaml, re
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
ns = next(d['metadata']['name'] for d in docs if d['kind'] == 'Namespace')
vap = next(d for d in docs if d['kind'] == 'ValidatingAdmissionPolicy')
img = next(re.search(r'c\.image == "([^"]+)"', v['expression']).group(1) for v in vap['spec']['validations'] if 'c.image ==' in v['expression'])
print(ns, img)
PY
)"
[ -n "$NS" ] && [ -n "$IMG" ] || { echo "could not read the scanner namespace / image from the render" >&2; exit 2; }
k apply -f "$render" >/dev/null || exit 2
rm -f "$render"
OSUI=system:serviceaccount:$REL:os-ui
WORKER=system:serviceaccount:$REL:os-ui-worker

# os-ui's OWN manifests (same builder the adapter POSTs from), at the chart's image and namespace.
real=$( cd os-ui && SCAN_NAMESPACE="$NS" SCAN_IMAGE="$IMG" node --experimental-test-module-mocks --import ./scripts/test-setup.mjs scripts/print-scan-job.ts 2>/dev/null ) || { echo "print-scan-job.ts failed" >&2; exit 2; }
JOB=$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])["job"]))' "$real")
SECRET=$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])["secret"]))' "$real")
JOBNAME=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["metadata"]["name"])' "$JOB")

# mutate <manifest-json> <python statements over `m` (the object) and `p` (its pod spec)>
mutate() {
  python3 - "$1" "$2" <<'PY'
import json, sys
m = json.loads(sys.argv[1])
p = m['spec']['template']['spec'] if m['kind'] == 'Job' else (m['spec'] if m['kind'] == 'Pod' else None)
c = p['containers'][0] if p else None
exec(sys.argv[2])
print(json.dumps(m))
PY
}
# The Pod the Job controller makes from the template: same spec, plus the controller's labels.
POD=$(python3 - "$JOB" <<'PY'
import json, sys
j = json.loads(sys.argv[1])
t = j['spec']['template']
labels = dict(t['metadata']['labels'], **{'batch.kubernetes.io/job-name': j['metadata']['name'], 'job-name': j['metadata']['name']})
print(json.dumps({'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': j['metadata']['name'] + '-abcde', 'namespace': j['metadata']['namespace'], 'labels': labels}, 'spec': t['spec']}))
PY
)
# write <as> <manifest> [kubectl args] — prints the API server's answer; exit = kubectl's.
write() { local who=$1 m=$2; shift 2; local as=(); [ "$who" = admin ] || as=(--as="$who"); echo "$m" | k -n "$NS" create ${as[@]+"${as[@]}"} -f - "$@" 2>&1; }
admitted() { local out; out=$(write "$@") && ok "$LABEL" || bad "$LABEL" "$out"; }
refused() { local want=$1; shift; local out; if out=$(write "$@"); then bad "$LABEL" "admitted: $out"; else check "$LABEL" "$want" "$out"; fi; }
DRY=--dry-run=server
OTHER_SECRET="p['volumes'][2]['secret']['secretName'] = 'litellm-credentials'"

# The API server compiles a new policy asynchronously: wait until it refuses a Secret-mounting Job.
for _ in $(seq 1 60); do write "$OSUI" "$(mutate "$JOB" "$OTHER_SECRET")" $DRY >/dev/null || break; sleep 2; done

echo "== the scanner's own objects are admitted (namespace $NS, image $IMG)"
LABEL="os-ui's real scan Job";                  admitted "$OSUI" "$JOB" $DRY
LABEL="the same Job from the agent-run worker"; admitted "$WORKER" "$JOB" $DRY
LABEL="os-ui's real payload Secret";            admitted "$OSUI" "$SECRET" $DRY
LABEL="the Pod the Job controller makes";       admitted admin "$POD" $DRY

echo "== everything else is refused"
LABEL="a Job that mounts another Secret";        refused "own payload Secret" "$OSUI" "$(mutate "$JOB" "$OTHER_SECRET")" $DRY
LABEL="a Job that mounts a second Secret";       refused "own payload Secret" "$OSUI" "$(mutate "$JOB" "p['volumes'].append({'name':'x','secret':{'secretName':'os-ui-session'}})")" $DRY
LABEL="a Job with envFrom a Secret";             refused "no envFrom" "$OSUI" "$(mutate "$JOB" "c['envFrom'] = [{'secretRef': {'name': 'litellm-credentials'}}]")" $DRY
LABEL="a Job with env secretKeyRef";             refused "no envFrom" "$OSUI" "$(mutate "$JOB" "c['env'].append({'name':'K','valueFrom':{'secretKeyRef':{'name':'os-ui-session','key':'k'}}})")" $DRY
LABEL="a Job with a projected token volume";     refused "own payload Secret" "$OSUI" "$(mutate "$JOB" "p['volumes'].append({'name':'t','projected':{'sources':[{'serviceAccountToken':{'path':'token'}}]}})")" $DRY
LABEL="a Job that automounts the token";         refused "no ServiceAccount token" "$OSUI" "$(mutate "$JOB" "del p['automountServiceAccountToken']")" $DRY
LABEL="a Job as another ServiceAccount";         refused "default ServiceAccount" "$OSUI" "$(mutate "$JOB" "p['serviceAccountName'] = 'os-ui'")" $DRY
LABEL="an unpinned image (tag only)";            refused "pinned scanner image" "$OSUI" "$(mutate "$JOB" "c['image'] = c['image'].split('@')[0]")" $DRY
LABEL="another image";                           refused "pinned scanner image" "$OSUI" "$(mutate "$JOB" "c['image'] = 'busybox:1.37.0'")" $DRY
LABEL="a hostPath volume";                       refused "own payload Secret" "$OSUI" "$(mutate "$JOB" "p['volumes'].append({'name':'h','hostPath':{'path':'/'}})")" $DRY
LABEL="host networking";                         refused "no host namespace" "$OSUI" "$(mutate "$JOB" "p['hostNetwork'] = True")" $DRY
# (privileged needs allowPrivilegeEscalation true, or the API server's own validation answers first)
LABEL="a privileged container";                  refused "runs restricted" "$OSUI" "$(mutate "$JOB" "c['securityContext'].update(privileged=True, allowPrivilegeEscalation=True)")" $DRY
LABEL="runAsNonRoot dropped";                    refused "runs restricted" "$OSUI" "$(mutate "$JOB" "del p['securityContext']['runAsNonRoot']")" $DRY
LABEL="an added capability";                     refused "runs restricted" "$OSUI" "$(mutate "$JOB" "c['securityContext']['capabilities']['add'] = ['NET_RAW']")" $DRY
LABEL="no resource limits";                      refused "requests and limits" "$OSUI" "$(mutate "$JOB" "del c['resources']['limits']")" $DRY
LABEL="no resource requests";                    refused "requests and limits" "$OSUI" "$(mutate "$JOB" "del c['resources']['requests']")" $DRY
LABEL="parallelism 2 (fan-out)";                 refused "runs one pod" "$OSUI" "$(mutate "$JOB" "m['spec']['parallelism'] = 2")" $DRY
LABEL="completions 3 (fan-out)";                 refused "runs one pod" "$OSUI" "$(mutate "$JOB" "m['spec']['completions'] = 3")" $DRY
LABEL="backoffLimit unset (6 retries)";          refused "runs one pod" "$OSUI" "$(mutate "$JOB" "del m['spec']['backoffLimit']")" $DRY
LABEL="a priorityClassName";                     refused "no priorityClassName" "$OSUI" "$(mutate "$JOB" "p['priorityClassName'] = 'system-cluster-critical'")" $DRY
LABEL="a writable payload mount";                refused "payload read-only" "$OSUI" "$(mutate "$JOB" "c['volumeMounts'][2]['readOnly'] = False")" $DRY
LABEL="an init container";                       refused "exactly one container" "$OSUI" "$(mutate "$JOB" "p['initContainers'] = [dict(c, name='init')]")" $DRY
LABEL="a Job not named os-scan-*";               refused "named os-scan-" "$OSUI" "$(mutate "$JOB" "m['metadata']['name'] = 'evil'; p['volumes'][2]['secret']['secretName'] = 'evil'")" $DRY
LABEL="a Pod (admin) that mounts another Secret"; refused "own payload Secret" admin "$(mutate "$POD" "$OTHER_SECRET")" $DRY
LABEL="a ServiceAccount-token Secret";           refused "Opaque scan payload" "$OSUI" "$(mutate "$SECRET" "m['type'] = 'kubernetes.io/service-account-token'; m['metadata']['annotations'] = {'kubernetes.io/service-account.name': 'default'}")" $DRY
LABEL="a Secret with another name";              refused "Opaque scan payload" "$OSUI" "$(mutate "$SECRET" "m['metadata']['name'] = 'litellm-credentials'")" $DRY
LABEL="a payload Secret with no owning Job";     refused "Opaque scan payload" "$OSUI" "$(mutate "$SECRET" "del m['metadata']['ownerReferences']")" $DRY

echo "== RBAC and Pod Security"
LABEL="os-ui cannot get Secrets in $NS";   check "$LABEL" no "$(k auth can-i get secrets -n "$NS" --as="$OSUI" 2>&1)"
LABEL="os-ui cannot list Secrets in $NS";  check "$LABEL" no "$(k auth can-i list secrets -n "$NS" --as="$OSUI" 2>&1)"
LABEL="os-ui can create scan Jobs in $NS"; check "$LABEL" yes "$(k auth can-i create jobs.batch -n "$NS" --as="$OSUI" 2>&1)"
LABEL="os-ui cannot create Pods in $NS";   check "$LABEL" no "$(k auth can-i create pods -n "$NS" --as="$OSUI" 2>&1)"
LABEL="the namespace enforces Pod Security restricted"; check "$LABEL" restricted "$(k get ns "$NS" -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}')"
LABEL="a ResourceQuota caps concurrent scans";   check "$LABEL" "software-scanner" "$(k -n "$NS" get resourcequota -o jsonpath='{.items[*].metadata.name}')"
LABEL="NetworkPolicies: default deny + scanner egress"; check "$LABEL" "software-scanner-default-deny software-scanner-egress" "$(k -n "$NS" get networkpolicy -o jsonpath='{.items[*].metadata.name}')"

echo "== twin"
k delete validatingadmissionpolicybinding "$REL-software-scanner-shape" >/dev/null
for _ in $(seq 1 60); do write "$OSUI" "$(mutate "$JOB" "$OTHER_SECRET")" $DRY >/dev/null && break; sleep 2; done
LABEL="without the binding os-ui's Secret-mounting Job is admitted (the refusals are the policy's)"; admitted "$OSUI" "$(mutate "$JOB" "$OTHER_SECRET")" $DRY
finish scanner-admission.kind
