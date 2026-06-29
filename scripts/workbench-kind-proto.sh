#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
#
# Domain-Builder Workbench — kind isolation/persistence proof (sign-off evidence).
#
# Proves the SECURITY MODEL of the workbench on a local kind cluster WITHOUT
# touching the live `agentic-os` namespace: it builds an isolated stand-in of the
# two trust tiers (broker RBAC + per-builder locked-down workspace) and asserts:
#
#   A. Workspace is non-root, has NO k8s token, cannot reach the API server.
#   B. DOMAIN-scoped creds: builder Bea (sales) gets ONLY the sales token; builder
#      Kenji (finance) gets ONLY the finance token — neither can see the other's.
#   C. PERSISTENCE: a per-builder PVC survives scale-to-0 -> scale-to-1 (the work
#      a builder leaves behind is still there next session).
#   D. Broker RBAC boundary: the broker SA may reconcile workspaces in the
#      WORKBENCH namespace ONLY — it cannot create workloads or read secrets in the
#      release namespace, and has no cluster scope (nodes/secrets-all-ns).
#
# kindnet does not enforce NetworkPolicy, so (like the terminal proto) the local
# egress guarantee rests on no-token + non-root + domain-scoped-creds; on STACKIT
# (Cilium) the per-builder NetworkPolicies enforce egress as designed.
#
# Usage: ./scripts/workbench-kind-proto.sh   (cleans up with: ... cleanup)
set -uo pipefail

REL_NS=wb-proto            # stands in for the release namespace
WB_NS=wb-proto-wb          # the workbench namespace
IMG=busybox:1.36           # tiny stand-in for the code-server runtime (security
                           # properties under test live in the Pod spec, not the app)
PASS=0; FAIL=0
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
hr()   { echo "----------------------------------------------------------------"; }

cleanup() {
  kubectl delete ns "$WB_NS" "$REL_NS" --ignore-not-found --wait=false >/dev/null 2>&1
  echo "cleaned up $WB_NS, $REL_NS"
}
if [ "${1:-}" = "cleanup" ]; then cleanup; exit 0; fi

trap 'echo; echo "(re-run with: $0 cleanup  to remove the proto namespaces)"' EXIT

echo "==> Setting up isolated proto namespaces (live agentic-os untouched)"
kubectl create ns "$REL_NS" >/dev/null 2>&1
kubectl create ns "$WB_NS"  >/dev/null 2>&1

# --- Trust tier 1: broker SA + least-privilege Role in the WORKBENCH ns only ---
kubectl -n "$REL_NS" create sa workbench-broker >/dev/null 2>&1
cat <<EOF | kubectl apply -f - >/dev/null
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: workbench-broker, namespace: $WB_NS }
rules:
  - { apiGroups: ["apps"], resources: ["deployments"], verbs: ["get","list","watch","create","patch","update","delete"] }
  - { apiGroups: ["apps"], resources: ["deployments/scale"], verbs: ["get","patch","update"] }
  - { apiGroups: [""], resources: ["pods"], verbs: ["get","list","watch","delete"] }
  - { apiGroups: [""], resources: ["services","endpoints"], verbs: ["get","list","watch","create","delete"] }
  - { apiGroups: [""], resources: ["persistentvolumeclaims"], verbs: ["get","list","create"] }
  - { apiGroups: [""], resources: ["secrets"], verbs: ["get","list","create","update"] }
  - { apiGroups: ["networking.k8s.io"], resources: ["networkpolicies"], verbs: ["get","list","create"] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: workbench-broker, namespace: $WB_NS }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: workbench-broker }
subjects: [{ kind: ServiceAccount, name: workbench-broker, namespace: $REL_NS }]
EOF

# workbench-nobody SA the workspaces run as: bound to nothing, no automount.
cat <<EOF | kubectl apply -f - >/dev/null
apiVersion: v1
kind: ServiceAccount
metadata: { name: workbench-nobody, namespace: $WB_NS }
automountServiceAccountToken: false
EOF

# --- Per-domain credential secrets (what the chart seeds) ---------------------
kubectl -n "$WB_NS" create secret generic workbench-domain-creds-sales \
  --from-literal=forgejoUser=sales-builder --from-literal=forgejoToken=SALES-TOKEN-aaa >/dev/null 2>&1
kubectl -n "$WB_NS" create secret generic workbench-domain-creds-finance \
  --from-literal=forgejoUser=finance-builder --from-literal=forgejoToken=FINANCE-TOKEN-bbb >/dev/null 2>&1

# --- Broker reconcile (simulated): per-builder creds Secret + PVC + workspace ---
# Bea -> sales: her per-builder Secret carries ONLY the sales domain token.
kubectl -n "$WB_NS" create secret generic wb-bea-creds \
  --from-literal=FORGEJO_USER=sales-builder --from-literal=FORGEJO_TOKEN=SALES-TOKEN-aaa \
  --from-literal=WORKBENCH_DOMAIN=sales >/dev/null 2>&1
# Kenji -> finance: his per-builder Secret carries ONLY the finance domain token.
kubectl -n "$WB_NS" create secret generic wb-kenji-creds \
  --from-literal=FORGEJO_USER=finance-builder --from-literal=FORGEJO_TOKEN=FINANCE-TOKEN-bbb \
  --from-literal=WORKBENCH_DOMAIN=finance >/dev/null 2>&1

make_workspace() {  # $1=owner  $2=creds-secret
  local owner="$1" creds="$2"
  cat <<EOF | kubectl apply -f - >/dev/null
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: wb-$owner-home, namespace: $WB_NS, labels: { soa.dev/workbench-owner: $owner } }
spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 256Mi } } }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: wb-$owner, namespace: $WB_NS, labels: { soa.dev/workbench-owner: $owner } }
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector: { matchLabels: { soa.dev/workbench-owner: $owner } }
  template:
    metadata: { labels: { soa.dev/workbench-owner: $owner } }
    spec:
      automountServiceAccountToken: false
      serviceAccountName: workbench-nobody
      enableServiceLinks: false
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: code-server
          image: $IMG
          command: ["sh","-c","mkdir -p /home/coder/project; sleep 3600"]
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, runAsUser: 1000, capabilities: { drop: [ALL] }, seccompProfile: { type: RuntimeDefault } }
          env: [{ name: HOME, value: /home/coder }]
          envFrom: [{ secretRef: { name: $creds } }]
          volumeMounts:
            - { name: home, mountPath: /home/coder }
            - { name: tmp, mountPath: /tmp }
      volumes:
        - { name: home, persistentVolumeClaim: { claimName: wb-$owner-home } }
        - { name: tmp, emptyDir: { sizeLimit: 64Mi } }
EOF
}

echo "==> Reconciling two builder workspaces (bea/sales, kenji/finance)"
make_workspace bea   wb-bea-creds
make_workspace kenji wb-kenji-creds
kubectl -n "$WB_NS" rollout status deploy/wb-bea   --timeout=90s >/dev/null 2>&1
kubectl -n "$WB_NS" rollout status deploy/wb-kenji --timeout=90s >/dev/null 2>&1

BEA=$(kubectl -n "$WB_NS" get pod -l soa.dev/workbench-owner=bea -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
KENJI=$(kubectl -n "$WB_NS" get pod -l soa.dev/workbench-owner=kenji -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
ex() { kubectl -n "$WB_NS" exec "$1" -- sh -c "$2" 2>/dev/null; }

hr; echo "A. Workspace lockdown (non-root, no token, no API)"
[ "$(ex "$BEA" 'id -u')" = "1000" ] && ok "runs non-root (uid 1000)" || bad "expected uid 1000"
ex "$BEA" 'test ! -e /var/run/secrets/kubernetes.io' && ok "NO_SA_DIR (no service-account token mounted)" || bad "service-account dir present"
ex "$BEA" 'test ! -e /var/run/secrets/kubernetes.io/serviceaccount/token' && ok "NO_TOKEN" || bad "token present"
ex "$BEA" 'which kubectl >/dev/null 2>&1' && bad "kubectl present" || ok "NO_KUBECTL (no cluster tooling to pivot)"
ex "$BEA" 'touch /nope 2>/dev/null' && bad "rootfs writable" || ok "ROOTFS_READONLY"
ex "$BEA" 'touch /home/coder/project/ok 2>/dev/null && echo y' >/dev/null && ok "HOME (PVC) is writable" || bad "PVC not writable"

hr; echo "B. Domain-scoped credentials (cross-domain separation)"
BEA_TOK=$(ex "$BEA" 'printf %s "$FORGEJO_TOKEN"'); BEA_DOM=$(ex "$BEA" 'printf %s "$WORKBENCH_DOMAIN"')
KEN_TOK=$(ex "$KENJI" 'printf %s "$FORGEJO_TOKEN"'); KEN_DOM=$(ex "$KENJI" 'printf %s "$WORKBENCH_DOMAIN"')
[ "$BEA_DOM" = "sales" ] && [ "$BEA_TOK" = "SALES-TOKEN-aaa" ] && ok "bea sees ONLY her sales domain token" || bad "bea domain/token wrong ($BEA_DOM/$BEA_TOK)"
[ "$KEN_DOM" = "finance" ] && [ "$KEN_TOK" = "FINANCE-TOKEN-bbb" ] && ok "kenji sees ONLY his finance domain token" || bad "kenji domain/token wrong"
case "$BEA_TOK" in *FINANCE*) bad "bea can see finance token";; *) ok "bea CANNOT see the finance token (cross-domain blocked)";; esac
# The workspace has no API token, so it cannot read the OTHER domain's Secret via the API either.
ex "$BEA" 'wget -T 4 -qO- --no-check-certificate https://kubernetes.default.svc/api/v1/namespaces/'"$WB_NS"'/secrets/workbench-domain-creds-finance 2>/dev/null | grep -q FINANCE' \
  && bad "bea read the finance secret via API" || ok "bea CANNOT read the finance secret via the k8s API (no token)"

hr; echo "C. Persistence across scale 0 -> 1 (per-builder PVC)"
MARK=domain-A-work-in-progress
# Wait for a Ready bea pod, write the marker, and CONFIRM it landed before we
# tear the pod down (retry to absorb pod-readiness races).
write_ok=""
for _ in 1 2 3 4 5; do
  kubectl -n "$WB_NS" wait --for=condition=Ready pod -l soa.dev/workbench-owner=bea --timeout=60s >/dev/null 2>&1
  BEA=$(kubectl -n "$WB_NS" get pod -l soa.dev/workbench-owner=bea -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  ex "$BEA" "printf '%s\n' $MARK > /home/coder/project/notes.txt"
  if [ "$(ex "$BEA" 'cat /home/coder/project/notes.txt 2>/dev/null')" = "$MARK" ]; then write_ok=1; break; fi
  sleep 2
done
[ -n "$write_ok" ] && echo "  (wrote notes.txt=$MARK to $BEA)" || echo "  (WARN: initial write did not land)"
kubectl -n "$WB_NS" scale deploy/wb-bea --replicas=0 >/dev/null 2>&1
kubectl -n "$WB_NS" wait --for=delete pod -l soa.dev/workbench-owner=bea --timeout=60s >/dev/null 2>&1
kubectl -n "$WB_NS" scale deploy/wb-bea --replicas=1 >/dev/null 2>&1
kubectl -n "$WB_NS" wait --for=condition=Ready pod -l soa.dev/workbench-owner=bea --timeout=90s >/dev/null 2>&1
BEA2=$(kubectl -n "$WB_NS" get pod -l soa.dev/workbench-owner=bea -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
persisted=""
for _ in 1 2 3 4 5; do
  [ "$(ex "$BEA2" 'cat /home/coder/project/notes.txt 2>/dev/null')" = "$MARK" ] && { persisted=1; break; }
  sleep 2
done
[ -n "$persisted" ] && ok "work persisted on the PVC across a full pod teardown/recreate (new pod $BEA2)" || bad "work did NOT persist"

hr; echo "D. Broker RBAC boundary (least privilege)"
# NB: $1 is intentionally UNquoted so "create deployments" word-splits into the
# verb + resource args `kubectl auth can-i` expects.
cani() { kubectl auth can-i $1 --as=system:serviceaccount:$REL_NS:workbench-broker ${2:+-n $2} 2>/dev/null; }
[ "$(cani 'create deployments' "$WB_NS")" = "yes" ] && ok "broker CAN reconcile deployments in the workbench ns" || bad "broker cannot manage its own ns"
[ "$(cani 'create persistentvolumeclaims' "$WB_NS")" = "yes" ] && ok "broker CAN create PVCs in the workbench ns" || bad "broker cannot create PVCs"
[ "$(cani 'create deployments' "$REL_NS")" = "no" ] && ok "broker CANNOT create workloads in the release ns" || bad "broker can write to the release ns!"
[ "$(cani 'get secrets' "$REL_NS")" = "no" ] && ok "broker CANNOT read secrets in the release ns" || bad "broker can read release secrets!"
[ "$(cani 'get secrets' kube-system)" = "no" ] && ok "broker CANNOT read secrets in kube-system" || bad "broker can read kube-system secrets!"
[ "$(cani 'list nodes')" = "no" ] && ok "broker has NO cluster scope (cannot list nodes)" || bad "broker has cluster scope!"

hr
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "ALL WORKBENCH ISOLATION/PERSISTENCE ASSERTIONS PASSED" || echo "SOME ASSERTIONS FAILED"
exit "$FAIL"
