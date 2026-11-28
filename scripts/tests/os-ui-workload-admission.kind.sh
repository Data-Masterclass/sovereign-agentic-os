#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# os-ui-workload-admission.kind.sh — os-ui's workload writes in the release namespace, on a real API server.
# =============================================================================
#   bash scripts/tests/os-ui-workload-admission.kind.sh [--keep]
#
# Needs docker, kind, kubectl, helm, node (os-ui dependencies installed), python3+pyyaml. Creates the
# kind cluster `$CLUSTER` (default `wpuiadm`) at the pinned node image, kubeconfig in $KIND_KUBECONFIG
# (never ~/.kube/config); deletes it on exit unless --keep. CHART_DIR overrides the chart (red run).
# Applies the chart's RENDERED os-ui Roles/RoleBindings in the release namespace and the
# os-ui-workload-shape policy + binding (external connectors, the worker and the App Builder registry
# on), plus stand-ins for the platform workloads, then:
#   1. os-ui's OWN code (os-ui/scripts/workload-rbac-probe.ts, the production k8s client with the os-ui
#      ServiceAccount's token) does what it does in production, and it all works: the Platform toggle
#      scales minio, the warehouse registration wires a Snowflake credential into Trino (and the Trino
#      container keeps its image, env and mounts — the strategic-merge fix), its removal, an agent
#      schedule CronJob created / replaced / deleted, the zot-users reconcile Job;
#   2. refused by RBAC: patching a Deployment other than trino, scaling a non-toggleable one, PUT of trino,
#      writing any ConfigMap but trino-catalog, reading or deleting a Secret; refused by the policy: any
#      Secret write but an Opaque trino-ext-* (a platform Secret's name, a ServiceAccount-token Secret);
#   3. refused by the POLICY (as os-ui, server dry runs): every pod-template change of trino that is not
#      the credential env shape (image, command, ServiceAccount, volume, envFrom, a non-credential env,
#      a credential env pointing at a platform Secret, dropping an env, securityContext, a probe, a pod
#      label, a non-rollout annotation); a CronJob that is not the agent-schedule shape; a change or a
#      delete of the chart's own CronJob; a Job as another ServiceAccount, or the zot-users Job with
#      another image or env; and — with RBAC opened up by a temporary Role — a Pod or a Deployment created
#      by os-ui at all;
#   4. twins: the same trino image change from a cluster admin is admitted (the policy binds only the
#      os-ui identities), and with the binding deleted os-ui's refused env patch is admitted — so the
#      refusals are the policy's.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
. tests/e2e/kind/versions.env
CLUSTER=${CLUSTER:-wpuiadm}
CHART_SRC=${CHART_DIR:-charts/sovereign-agentic-os}
KIND_KUBECONFIG=${KIND_KUBECONFIG:-$(mktemp -d)/kubeconfig}
CTX=kind-$CLUSTER
KEEP=${1:-}
NS=agentic-os
WORK=$(mktemp -d)
cleanup() { rm -rf "$WORK"; [ "$KEEP" = --keep ] || kind delete cluster --name "$CLUSTER" --kubeconfig "$KIND_KUBECONFIG" >/dev/null 2>&1; }
trap cleanup EXIT
k() { kubectl --kubeconfig "$KIND_KUBECONFIG" --context "$CTX" "$@"; }

if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --kubeconfig "$KIND_KUBECONFIG" --image "$KIND_NODE_IMAGE" || exit 2
fi
k wait --for=condition=Ready node --all --timeout=300s >/dev/null || exit 2
k create namespace "$NS" >/dev/null 2>&1
for sa in os-ui os-ui-worker zot-users; do k -n "$NS" create serviceaccount "$sa" >/dev/null 2>&1; done

# The App Builder registry renders only with a builder digest from the gated list: a test digest, on a COPY.
TEST_DIGEST=sha256:$(printf 'a%.0s' $(seq 64))
cp -R "$CHART_SRC" "$WORK/chart"
echo "$TEST_DIGEST builder-vtest 0" >> "$WORK/chart/files/builder-digests.txt"
helm template "$NS" "$WORK/chart" -n "$NS" --skip-schema-validation --set global.allowChartDefaultSecrets=true \
  --set osUI.externalConnectorsEnabled=true --set osUI.worker.enabled=true \
  --set osUI.software.tekton.enabled=true --set 'networkPolicies.apiserver.cidrs={10.96.0.1/32}' --set egressProxy.enabled=true \
  --set softwareRunner.environments.enabled=true --set osUI.software.registry.host=registry.dev.example.com \
  --set 'osUI.software.registry.allowedSourceRanges={203.0.113.7/32}' --set "softwareRunner.environments.build.image=ghcr.io/example/builder@$TEST_DIGEST" \
  --set softwareRunner.environments.build.isolation=dedicated-nodes --set 'softwareRunner.environments.build.dedicatedNodes.nodeSelector.pool=build' \
  > "$WORK/render.yaml" 2>"$WORK/render.err" || { cat "$WORK/render.err" >&2; exit 2; }
# The policy + binding, os-ui's Roles/RoleBindings in the release namespace, and the chart's zot-users CronJob.
python3 - "$WORK/render.yaml" "$NS" > "$WORK/apply.yaml" <<'PY' || exit 2
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
ns = sys.argv[2]
ours = lambda d: any(s.get('kind') == 'ServiceAccount' and s.get('name') in ('os-ui', 'os-ui-worker') for s in d.get('subjects', []))
bound = {d['roleRef']['name'] for d in docs if d['kind'] == 'RoleBinding' and d['metadata'].get('namespace') == ns and ours(d)}
keep = [d for d in docs if (d['kind'].startswith('ValidatingAdmissionPolicy') and 'os-ui-workload-shape' in d['metadata']['name'])
        or (d['kind'] == 'RoleBinding' and d['metadata'].get('namespace') == ns and ours(d))
        or (d['kind'] == 'Role' and d['metadata'].get('namespace') == ns and d['metadata']['name'] in bound)
        or (d['kind'] == 'CronJob' and d['metadata']['name'] == 'zot-users')]
print(yaml.safe_dump_all(keep))
PY
k apply -n "$NS" -f "$WORK/apply.yaml" >/dev/null || exit 2
grep -q 'os-ui-workload-shape' "$WORK/apply.yaml" || { echo "the render has no os-ui-workload-shape policy" >&2; exit 2; }

# Stand-ins for the platform workloads os-ui touches (replicas 0: the API objects are what matter).
PAUSE=registry.k8s.io/pause:3.10
deploy() { # deploy <name> [extra-container-json]
  python3 -c '
import json, sys
name = sys.argv[1]
c = {"name": name, "image": sys.argv[2], "env": [{"name": "JAVA_HOME", "value": "/usr/lib/jvm"}, {"name": "OPA_URL", "value": "http://opa:8181"}],
     "volumeMounts": [{"name": "catalog", "mountPath": "/etc/trino/catalog", "readOnly": True}]}
labels = {"app.kubernetes.io/name": name, "app.kubernetes.io/component": name}
print(json.dumps({"apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": name, "labels": labels},
  "spec": {"replicas": 0, "strategy": {"type": "Recreate"}, "selector": {"matchLabels": labels}, "template": {"metadata": {"labels": labels},
    "spec": {"serviceAccountName": "default", "containers": [c], "volumes": [{"name": "catalog", "configMap": {"name": "trino-catalog"}}]}}}}))
' "$1" "$PAUSE" | k -n "$NS" apply -f - >/dev/null
}
for d in trino minio os-ui; do deploy "$d" || exit 2; done
k -n "$NS" create configmap trino-catalog --from-literal=iceberg.properties=connector.name=iceberg >/dev/null 2>&1
k -n "$NS" create configmap opa-policy --from-literal=policy.rego=package x >/dev/null 2>&1
k -n "$NS" create secret generic agent-runtime-token --from-literal=token=kind-test-only >/dev/null 2>&1

OSUI=system:serviceaccount:$NS:os-ui
WORKER=system:serviceaccount:$NS:os-ui-worker
# os-ui's own ServiceAccount token + the cluster CA, where core/infra/k8s.ts reads them (OS_K8S_SA_DIR).
SA_DIR=$WORK/sa; mkdir -p "$SA_DIR"
k -n "$NS" create token os-ui --duration=1h > "$SA_DIR/token" || exit 2
k config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d > "$SA_DIR/ca.crt"
API=$(k config view --minify -o jsonpath='{.clusters[0].cluster.server}')
probe() { ( cd os-ui && OS_K8S_SA_DIR="$SA_DIR" KUBERNETES_API="$API" NAMESPACE="$NS" \
  SOFTWARE_TEKTON_NAMESPACE=agentic-build APP_REGISTRY=registry.dev.example.com \
  node --experimental-test-module-mocks --import ./scripts/test-setup.mjs scripts/workload-rbac-probe.ts "$@" 2>&1 ); }

# The API server compiles a new policy asynchronously: wait until it refuses a forged image patch.
IMGPATCH='{"spec":{"template":{"spec":{"containers":[{"name":"trino","image":"busybox:1.37.0"}]}}}}'
for _ in $(seq 1 60); do k -n "$NS" patch deploy trino --as="$OSUI" --type=strategic -p "$IMGPATCH" --dry-run=server >/dev/null 2>&1 || break; sleep 2; done

echo "== os-ui's own writes (the production code, as the os-ui ServiceAccount) work"
LABEL="Platform toggle scales minio (PATCH /scale)"; out=$(probe toggle minio); check "$LABEL" '"ok":true' "$out"
holds "minio is at 1 replica" [ "$(k -n "$NS" get deploy minio -o jsonpath='{.spec.replicas}')" = 1 ]
LABEL="warehouse registration wires the Snowflake credential into Trino"; out=$(probe register); check "$LABEL" '"ok":true' "$out"
tpl=$(k -n "$NS" get deploy trino -o json)
pyq() { python3 -c "import json,sys; d=json.load(sys.stdin)['spec']['template']; c=d['spec']['containers']; print($1)" <<<"$tpl"; }
holds "the trino container keeps its image (strategic merge, not a list replace)" [ "$(pyq "c[0]['image']")" = "$PAUSE" ]
holds "...and its mounts and its other env" [ "$(pyq "len(c)==1 and c[0]['volumeMounts'][0]['name']=='catalog' and any(e['name']=='JAVA_HOME' for e in c[0]['env'])")" = True ]
holds "...and gains SNOWFLAKE_PRIVATE_KEY from trino-ext-snow-fin (optional)" \
  [ "$(pyq "[e['valueFrom']['secretKeyRef'] for e in c[0]['env'] if e['name']=='SNOWFLAKE_PRIVATE_KEY'][0] == dict(name='trino-ext-snow-fin', key='SNOWFLAKE_PRIVATE_KEY', optional=True)")" = True ]
holds "...and the rollout annotation" [ "$(pyq "'soa.dev/catalog-registered' in d['metadata'].get('annotations',{})")" = True ]
LABEL="registering again (same catalog) is admitted"; out=$(probe register); check "$LABEL" '"ok":true' "$out"
LABEL="removing the registration"; out=$(probe remove); check "$LABEL" '"ok":true' "$out"
holds "...blanks trino-ext-snow-fin by PUT (no credential left; os-ui has no Secret delete)" \
  [ "$(k -n "$NS" get secret trino-ext-snow-fin -o jsonpath='{.data}')" = "" ]
LABEL="agent schedule CronJob created"; out=$(probe schedule kind-probe); check "$LABEL" '"action":"created"' "$out"
LABEL="agent schedule CronJob replaced (PUT)"; out=$(probe schedule kind-probe); check "$LABEL" '"action":"updated"' "$out"
LABEL="agent schedule CronJob deleted"; out=$(probe unschedule kind-probe); check "$LABEL" '"action":"deleted"' "$out"
LABEL="zot-users reconcile Job from the chart CronJob's template"; out=$(probe zot); check "$LABEL" '"ok":true' "$out"

echo "== refused by RBAC"
refuse_as() { local who=$1 want=$2; shift 2; local o; if o=$(k -n "$NS" --as="$who" "$@" 2>&1); then bad "$LABEL" "admitted: $o"; else check "$LABEL" "$want" "$o"; fi; }
create_as() { local who=$1 want=$2 m=$3; local o; if o=$(echo "$m" | k -n "$NS" create --as="$who" -f - --dry-run=server 2>&1); then bad "$LABEL" "admitted: $o"; else check "$LABEL" "$want" "$o"; fi; }
LABEL="patch a Deployment other than trino"; refuse_as "$OSUI" forbidden patch deploy minio --type=strategic -p '{"spec":{"template":{"metadata":{"annotations":{"x":"y"}}}}}' --dry-run=server
LABEL="scale a non-toggleable Deployment (os-ui)"; refuse_as "$OSUI" forbidden patch deploy os-ui --subresource=scale --type=merge -p '{"spec":{"replicas":2}}' --dry-run=server
LABEL="replace (PUT) the trino Deployment"; refuse_as "$OSUI" forbidden replace -f <(k -n "$NS" get deploy trino -o json) --dry-run=server
LABEL="patch a platform ConfigMap (opa-policy)"; refuse_as "$OSUI" forbidden patch configmap opa-policy --type=merge -p '{"data":{"x":"y"}}' --dry-run=server
LABEL="create a ConfigMap"; refuse_as "$OSUI" forbidden create configmap evil --from-literal=a=b --dry-run=server
LABEL="read a Secret"; refuse_as "$OSUI" forbidden get secret agent-runtime-token
LABEL="delete a Secret"; refuse_as "$OSUI" forbidden delete secret trino-ext-snow-fin --dry-run=server

echo "== refused by the policy: Secret writes other than an Opaque trino-ext-*"
LABEL="an Opaque trino-ext-* Secret is admitted (dry run)"
if o=$(k -n "$NS" create secret generic trino-ext-probe --from-literal=K=v --as="$OSUI" --dry-run=server 2>&1); then ok "$LABEL"; else bad "$LABEL" "$o"; fi
LABEL="create a platform-named Secret (litellm-credentials)"; refuse_as "$OSUI" "only Opaque trino-ext-*" create secret generic litellm-credentials --from-literal=K=v --dry-run=server
LABEL="overwrite (PUT) agent-runtime-token"; refuse_as "$OSUI" "only Opaque trino-ext-*" replace -f <(k -n "$NS" get secret agent-runtime-token -o json | python3 -c 'import json,sys; m=json.load(sys.stdin); m["data"]={"token":"ZXZpbA=="}; print(json.dumps(m))') --dry-run=server
SATOKEN=$(python3 -c 'import json; print(json.dumps(dict(apiVersion="v1", kind="Secret", type="kubernetes.io/service-account-token", metadata=dict(name="trino-ext-token", annotations={"kubernetes.io/service-account.name": "zot-users"}))))')
LABEL="plant a ServiceAccount-token Secret named trino-ext-*"; create_as "$OSUI" "only Opaque trino-ext-*" "$SATOKEN"

echo "== refused by the policy: trino's pod template beyond the credential env"
sp() { refuse_as "$OSUI" "$1" patch deploy trino --type=strategic -p "$2" --dry-run=server; }
C='{"spec":{"template":{"spec":{"containers":[{"name":"trino",'; E='}]}}}}'
LABEL="change the image";              sp "nor change its image" "$IMGPATCH"
LABEL="change the command";            sp "nor change its image, command" "${C}\"command\":[\"sh\",\"-c\",\"id\"]${E}"
LABEL="add an exec liveness probe";    sp "probes" "${C}\"livenessProbe\":{\"exec\":{\"command\":[\"sh\"]}}${E}"
LABEL="privileged securityContext";    sp "securityContext" "${C}\"securityContext\":{\"privileged\":true}${E}"
LABEL="envFrom a platform Secret";     sp "envFrom" "${C}\"envFrom\":[{\"secretRef\":{\"name\":\"postgres-app\"}}]${E}"
LABEL="a non-credential env (JAVA_TOOL_OPTIONS)"; sp "may change env only" "${C}\"env\":[{\"name\":\"JAVA_TOOL_OPTIONS\",\"value\":\"-javaagent:/x.jar\"}]${E}"
LABEL="a credential env from a platform Secret"; sp "may change env only" "${C}\"env\":[{\"name\":\"POSTGRESQL_PASSWORD\",\"valueFrom\":{\"secretKeyRef\":{\"name\":\"postgres-app\",\"key\":\"password\"}}}]${E}"
LABEL="a credential env with another key"; sp "may change env only" "${C}\"env\":[{\"name\":\"POSTGRESQL_PASSWORD\",\"valueFrom\":{\"secretKeyRef\":{\"name\":\"trino-ext-x\",\"key\":\"password\"}}}]${E}"
LABEL="a credential env as a literal value"; sp "may change env only" "${C}\"env\":[{\"name\":\"POSTGRESQL_PASSWORD\",\"value\":\"x\"}]${E}"
LABEL="drop an existing env (OPA_URL)"; sp "may change env only" "${C}\"env\":[{\"name\":\"OPA_URL\",\"\$patch\":\"delete\"}]${E}"
LABEL="another ServiceAccount";        sp "ServiceAccount" '{"spec":{"template":{"spec":{"serviceAccountName":"agentic-os-dagster"}}}}'
LABEL="mount a platform Secret";       sp "volumes" '{"spec":{"template":{"spec":{"volumes":[{"name":"s","secret":{"secretName":"postgres-app"}}]}}}}'
LABEL="host networking";               sp "host namespaces" '{"spec":{"template":{"spec":{"hostNetwork":true}}}}'
LABEL="relabel the pods as os-ui";     sp "pod labels" '{"spec":{"template":{"metadata":{"labels":{"app.kubernetes.io/part-of":"os-ui"}}}}}'
LABEL="an AppArmor-unconfined annotation"; sp "rollout annotations" '{"spec":{"template":{"metadata":{"annotations":{"container.apparmor.security.beta.kubernetes.io/trino":"unconfined"}}}}}'

echo "== refused by the policy: CronJobs and Jobs that are not os-ui's own shapes"
real_cron=$( cd os-ui && node --experimental-test-module-mocks --import ./scripts/test-setup.mjs scripts/print-schedule-cronjob.ts 2>/dev/null ) || { bad "print-schedule-cronjob.ts"; real_cron='{}'; }
# mutate <manifest-json> <python statement>: `ps` is the pod spec (CronJob or Job), `c0` its first container.
# Statements use dict(...), not {...}: bash brace-expands a {a,b} word inside "$(...)".
mutate() { python3 -c '
import json, sys
m = json.loads(sys.argv[1]); m.get("metadata", {}).pop("namespace", None)
ps = (m["spec"]["jobTemplate"]["spec"] if m.get("kind") == "CronJob" else m["spec"])["template"]["spec"] if "spec" in m else {}
c0 = ps.get("containers", [{}])[0]
exec(sys.argv[2]); print(json.dumps(m))' "$1" "$2"; }
LABEL="the real agent-schedule CronJob is admitted (dry run)"
if o=$(mutate "$real_cron" 'pass' | k -n "$NS" create --as="$OSUI" -f - --dry-run=server 2>&1); then ok "$LABEL"; else bad "$LABEL" "$o"; fi
LABEL="a schedule CronJob running busybox"; create_as "$OSUI" "schedule image" "$(mutate "$real_cron" "c0['image']='busybox:1.37.0'")"
LABEL="a schedule CronJob with a ServiceAccount token"; create_as "$OSUI" "no token" "$(mutate "$real_cron" "ps['automountServiceAccountToken']=True")"
LABEL="a schedule CronJob as another ServiceAccount"; create_as "$OSUI" "default ServiceAccount" "$(mutate "$real_cron" "ps['serviceAccountName']='zot-users'")"
LABEL="a schedule CronJob mounting a Secret"; create_as "$OSUI" "no volume" "$(mutate "$real_cron" "ps['volumes']=[dict(name='s', secret=dict(secretName='postgres-app'))]")"
LABEL="a schedule CronJob reading another Secret"; create_as "$OSUI" "runtime token" "$(mutate "$real_cron" "c0['env'].append(dict(name='PW', valueFrom=dict(secretKeyRef=dict(name='postgres-app', key='password'))))")"
LABEL="a CronJob not named agent-schedule-*"; create_as "$OSUI" "agent schedule" "$(mutate "$real_cron" "m['metadata']['name']='backup-nightly'")"
LABEL="replace (PUT) the chart's zot-users CronJob"; refuse_as "$OSUI" "agent schedule" replace -f <(k -n "$NS" get cronjob zot-users -o json | python3 -c 'import json,sys; m=json.load(sys.stdin); m["spec"]["schedule"]="* * * * *"; print(json.dumps(m))') --dry-run=server
LABEL="delete the chart's zot-users CronJob (os-ui)"; refuse_as "$OSUI" "deletes only" delete cronjob zot-users --dry-run=server
LABEL="delete the chart's zot-users CronJob (os-ui-worker)"; refuse_as "$WORKER" "deletes only" delete cronjob zot-users --dry-run=server
zot_job=$(k -n "$NS" get cronjob zot-users -o json | python3 -c '
import json, sys
cj = json.load(sys.stdin)
print(json.dumps({"apiVersion": "batch/v1", "kind": "Job", "metadata": {"name": "zot-users-probe"}, "spec": cj["spec"]["jobTemplate"]["spec"]}))')
LABEL="the zot-users Job from the CronJob's template is admitted (dry run)"
if o=$(echo "$zot_job" | k -n "$NS" create --as="$OSUI" -f - --dry-run=server 2>&1); then ok "$LABEL"; else bad "$LABEL" "$o"; fi
LABEL="a zot-users Job running busybox"; create_as "$OSUI" "zot-users reconcile" "$(mutate "$zot_job" "c0['image']='busybox:1.37.0'")"
LABEL="a zot-users Job with another command"; create_as "$OSUI" "zot-users reconcile" "$(mutate "$zot_job" "c0['command']=['sh','-c','cat /var/run/secrets/kubernetes.io/serviceaccount/token']")"
LABEL="a zot-users Job sending to another registry"; create_as "$OSUI" "zot-users reconcile" "$(mutate "$zot_job" "[e.update(value='evil.example.com') for e in c0['env'] if e['name']=='REGISTRY_HOST']")"
LABEL="a zot-users Job mounting a Secret"; create_as "$OSUI" "zot-users reconcile" "$(mutate "$zot_job" "ps['volumes'].append(dict(name='s', secret=dict(secretName='zot-auth')))")"
LABEL="a Job as another ServiceAccount"; create_as "$OSUI" "runs as one of" "$(mutate "$zot_job" "ps['serviceAccountName']='agentic-os-dagster'")"
# The binary-swap attack: a ConfigMap holding an executable (binaryData), mounted by subPath over the command
# with mode 0755, would run any code as zot-users. Each ingredient alone is refused, and together.
LABEL="zot-users Job: binaryData ConfigMap by subPath over the binary, mode 0755"; create_as "$OSUI" "zot-users reconcile" "$(mutate "$zot_job" "ps['volumes'].append(dict(name='bin', configMap=dict(name='evil-bin', defaultMode=493))); c0['volumeMounts'].append(dict(name='bin', mountPath='/usr/local/bin/zot-users', subPath='zot-users'))")"
LABEL="zot-users Job: the template mounted by subPath"; create_as "$OSUI" "zot-users reconcile" "$(mutate "$zot_job" "c0['volumeMounts'][0]['subPath']='x'")"
LABEL="zot-users Job: the template mounted over /usr/local/bin"; create_as "$OSUI" "zot-users reconcile" "$(mutate "$zot_job" "c0['volumeMounts'][0]['mountPath']='/usr/local/bin'")"
LABEL="zot-users Job: the template with mode 0755"; create_as "$OSUI" "zot-users reconcile" "$(mutate "$zot_job" "ps['volumes'][0]['configMap']['defaultMode']=493")"
LABEL="zot-users Job: the template with items (key to path)"; create_as "$OSUI" "zot-users reconcile" "$(mutate "$zot_job" "ps['volumes'][0]['configMap']['items']=[dict(key='a', path='zot-users', mode=493)]")"
LABEL="zot-users Job: another ConfigMap as the template"; create_as "$OSUI" "zot-users reconcile" "$(mutate "$zot_job" "ps['volumes'][0]['configMap']['name']='evil-bin'")"
LABEL="zot-users Job: an exec probe"; create_as "$OSUI" "zot-users reconcile" "$(mutate "$zot_job" "c0['startupProbe']=dict(exec=dict(command=['sh','-c','id']))")"
LABEL="zot-users Job: a postStart hook"; create_as "$OSUI" "zot-users reconcile" "$(mutate "$zot_job" "c0['lifecycle']=dict(postStart=dict(exec=dict(command=['sh'])))")"
LABEL="zot-users Job: a workingDir"; create_as "$OSUI" "zot-users reconcile" "$(mutate "$zot_job" "c0['workingDir']='/tmp'")"
LABEL="zot-users Job: run as root"; create_as "$OSUI" "zot-users reconcile" "$(mutate "$zot_job" "ps['securityContext']['runAsUser']=0")"
LABEL="zot-users Job: a writable root filesystem"; create_as "$OSUI" "zot-users reconcile" "$(mutate "$zot_job" "c0['securityContext']['readOnlyRootFilesystem']=False")"
LABEL="zot-users Job: labelled as os-ui"; create_as "$OSUI" "zot-users reconcile" "$(mutate "$zot_job" "m['spec']['template']['metadata']['labels']['app.kubernetes.io/part-of']='os-ui'")"

echo "== refused by the policy even where RBAC would allow it (a temporary Role)"
k -n "$NS" create role tmp-open --verb=create --resource=pods,deployments.apps >/dev/null
k -n "$NS" create rolebinding tmp-open --role=tmp-open --serviceaccount="$NS:os-ui" >/dev/null
LABEL="os-ui creates a Pod"; create_as "$OSUI" "creates no Pod" "$(k -n "$NS" run probe --image="$PAUSE" --dry-run=client -o json)"
LABEL="os-ui creates a Deployment"; create_as "$OSUI" "creates no Pod, Deployment" "$(k -n "$NS" create deployment probe --image="$PAUSE" --dry-run=client -o json)"
k -n "$NS" delete rolebinding tmp-open >/dev/null; k -n "$NS" delete role tmp-open >/dev/null

echo "== twins"
LABEL="the same trino image change from a cluster admin is admitted (only os-ui identities are bound)"
if o=$(k -n "$NS" patch deploy trino --type=strategic -p "$IMGPATCH" --dry-run=server 2>&1); then ok "$LABEL"; else bad "$LABEL" "$o"; fi
k delete validatingadmissionpolicybinding "$NS-os-ui-workload-shape" >/dev/null
JTO="${C}\"env\":[{\"name\":\"JAVA_TOOL_OPTIONS\",\"value\":\"-javaagent:/x.jar\"}]${E}"
for _ in $(seq 1 60); do k -n "$NS" patch deploy trino --as="$OSUI" --type=strategic -p "$JTO" --dry-run=server >/dev/null 2>&1 && break; sleep 2; done
LABEL="without the binding os-ui's JAVA_TOOL_OPTIONS patch is admitted"
if o=$(k -n "$NS" patch deploy trino --as="$OSUI" --type=strategic -p "$JTO" --dry-run=server 2>&1); then ok "$LABEL"; else bad "$LABEL" "$o"; fi
finish os-ui-workload-admission.kind
