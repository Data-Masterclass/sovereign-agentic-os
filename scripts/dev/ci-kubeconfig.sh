#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# ci-kubeconfig.sh — the kubeconfig the `dev` GitHub Environment holds (secret DEV_KUBECONFIG).
# =============================================================================
#   scripts/dev/ci-kubeconfig.sh      -> $DEV_PRIVATE_DIR/ci-kubeconfig.yaml (mode 600)
#
# A ServiceAccount `sovereign-os-ci` in namespace sovereign-os-ci of the DEV cluster, bound to
# cluster-admin OF THE DEV CLUSTER, with a long-lived token Secret. Why cluster-admin: the chart
# installs cluster-scoped objects (PriorityClasses, the agentic-apps namespace, RBAC) and the
# harness creates and deletes probe pods; a narrower role would break the deploy. The blast
# radius is the dev cluster: it holds synthetic data only, is in its own STACKIT project with no
# route to production, and this credential is not valid on any other cluster.
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
kind: ClusterRoleBinding
metadata: { name: sovereign-os-ci-dev-admin }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: cluster-admin }
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
