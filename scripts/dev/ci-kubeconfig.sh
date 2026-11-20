#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# ci-kubeconfig.sh — the kubeconfig the `dev` GitHub Environment holds (secret DEV_KUBECONFIG).
# =============================================================================
#   scripts/dev/ci-kubeconfig.sh      -> $DEV_PRIVATE_DIR/ci-kubeconfig.yaml (mode 600)
#
# A ServiceAccount `sovereign-os-ci` in namespace sovereign-os-ci of the DEV cluster, with a
# long-lived token Secret, and a NAMESPACED deploy role — NOT cluster-admin:
#   - Role sovereign-os-ci-deploy (everything) in agentic-os and agentic-apps only: what helm
#     installs there, and what the acceptance journeys create, exec into, scale and delete;
#   - ClusterRole sovereign-os-ci-cluster: the ONE cluster-scoped kind the chart renders
#     (PriorityClass), plus get on namespaces (helm --create-namespace checks they exist);
#   - Role sovereign-os-ci-marker: get on kube-public/sovereign-os-environment (the env guard).
# It has NO rights in dev-model-key, so it cannot read the STACKIT model key, which lives only
# there (bootstrap-secrets.sh). The platform add-ons, the namespaces and the marker are the
# operator's (admin kubeconfig), never CI's.
#
# The owner stores it (not this script):
#   gh secret set DEV_KUBECONFIG --env dev --repo Data-Masterclass/sovereign-agentic-os \
#     < ~/.sovereign-os-secrets/dev/ci-kubeconfig.yaml
# Revoke: kubectl --context dmagosdev -n sovereign-os-ci delete secret sovereign-os-ci-token
. "$(dirname "$0")/lib.sh"
require_marked_dev
private_dir
OUT=$DEV_PRIVATE_DIR/ci-kubeconfig.yaml
k apply -f - >/dev/null <<'YAML'
apiVersion: v1
kind: Namespace
metadata: { name: sovereign-os-ci }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: sovereign-os-ci, namespace: sovereign-os-ci }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: sovereign-os-ci-cluster }
rules:
  - { apiGroups: [scheduling.k8s.io], resources: [priorityclasses], verbs: ["*"] }
  - { apiGroups: [""], resources: [namespaces], verbs: [get, list] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: sovereign-os-ci-cluster }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: sovereign-os-ci-cluster }
subjects: [{ kind: ServiceAccount, name: sovereign-os-ci, namespace: sovereign-os-ci }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: sovereign-os-ci-marker, namespace: kube-public }
rules:
  - { apiGroups: [""], resources: [configmaps], resourceNames: [sovereign-os-environment], verbs: [get] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: sovereign-os-ci-marker, namespace: kube-public }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: sovereign-os-ci-marker }
subjects: [{ kind: ServiceAccount, name: sovereign-os-ci, namespace: sovereign-os-ci }]
---
apiVersion: v1
kind: Secret
metadata:
  name: sovereign-os-ci-token
  namespace: sovereign-os-ci
  annotations: { kubernetes.io/service-account.name: sovereign-os-ci }
type: kubernetes.io/service-account-token
YAML
for ns in agentic-os agentic-apps; do
  k get ns "$ns" >/dev/null 2>&1 || k create ns "$ns" >/dev/null
  k apply -f - >/dev/null <<YAML
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: sovereign-os-ci-deploy, namespace: $ns }
rules:
  - { apiGroups: ["*"], resources: ["*"], verbs: ["*"] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: sovereign-os-ci-deploy, namespace: $ns }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: sovereign-os-ci-deploy }
subjects: [{ kind: ServiceAccount, name: sovereign-os-ci, namespace: sovereign-os-ci }]
YAML
done
# Proof, from the API server itself: the CI account cannot read the model key.
SA=system:serviceaccount:sovereign-os-ci:sovereign-os-ci
if k auth can-i get secret/stackit-model-key -n dev-model-key --as "$SA" >/dev/null 2>&1; then
  die "the CI account CAN read dev-model-key/stackit-model-key — refusing to hand out this credential"
fi
echo "   checked: $SA cannot get secrets in dev-model-key"
k delete clusterrolebinding sovereign-os-ci-dev-admin --ignore-not-found >/dev/null   # the earlier cluster-admin binding
for _ in $(seq 1 30); do
  k -n sovereign-os-ci get secret sovereign-os-ci-token -o jsonpath='{.data.token}' 2>/dev/null | grep -q . && break
  sleep 2
done
SERVER=$(server_of "$CTX")
( umask 077
  k -n sovereign-os-ci get secret sovereign-os-ci-token -o json | python3 -c '
import base64, json, sys, yaml
s = json.load(sys.stdin)["data"]; ctx, server = sys.argv[1], sys.argv[2]
cfg = {"apiVersion": "v1", "kind": "Config", "current-context": ctx,
       "clusters": [{"name": ctx, "cluster": {"server": server, "certificate-authority-data": s["ca.crt"]}}],
       "users": [{"name": "sovereign-os-ci", "user": {"token": base64.b64decode(s["token"]).decode()}}],
       "contexts": [{"name": ctx, "context": {"cluster": ctx, "user": "sovereign-os-ci", "namespace": "agentic-os"}}]}
yaml.safe_dump(cfg, sys.stdout, sort_keys=False)' "$CTX" "$SERVER" > "$OUT" )
chmod 600 "$OUT"
echo "wrote $OUT (context $CTX, ServiceAccount sovereign-os-ci). Store it as the dev environment secret DEV_KUBECONFIG."
