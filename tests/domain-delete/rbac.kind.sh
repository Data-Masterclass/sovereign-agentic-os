#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Delete domain RBAC on a REAL API server: the chart's own ServiceAccount, Roles and RoleBindings
# (rendered with the software runner and Velero on), applied to a throwaway kind cluster with its
# OWN kubeconfig, then `kubectl auth can-i --as=system:serviceaccount:agentic-os:os-ui` for every
# verb the run needs — and negative twins for what it must NOT have.
#
#   KIND=kind bash tests/domain-delete/rbac.kind.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
KIND=${KIND:-kind}
NAME=${DD_KIND_NAME:-dd-rbac}
WORK=$(mktemp -d)
export KUBECONFIG="$WORK/kubeconfig"
cleanup() { "$KIND" delete cluster --name "$NAME" --kubeconfig "$KUBECONFIG" >/dev/null 2>&1 || true; }
trap cleanup EXIT
"$KIND" create cluster --name "$NAME" --kubeconfig "$KUBECONFIG" --wait 120s >/dev/null
helm template agentic-os charts/sovereign-agentic-os -n agentic-os --skip-schema-validation \
  --set softwareRunner.enabled=true --set domainDelete.veleroNamespace=velero 2>/dev/null > "$WORK/all.yaml"
python3 - "$WORK/all.yaml" "$WORK/rbac.yaml" <<'PY'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
keep = [d for d in docs if d.get("kind") in ("Role", "RoleBinding", "Namespace")
        or (d.get("kind") == "ServiceAccount" and d["metadata"]["name"] == "os-ui")]
for d in keep:
    if d["kind"] != "Namespace":
        d["metadata"].setdefault("namespace", "agentic-os")
yaml.safe_dump_all(keep, open(sys.argv[2], "w"))
print(f"{len(keep)} RBAC objects from the chart")
PY
for ns in agentic-os velero; do kubectl create namespace "$ns" >/dev/null 2>&1 || true; done
# The two foreign resource types must exist for `auth can-i` to resolve them: minimal CRDs with the
# upstream group/version/plural (cert-manager.io/v1 Certificate, velero.io/v1 Backup).
crd() { # group plural kind
  cat <<YAML | kubectl apply -f - >/dev/null
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata: { name: $2.$1 }
spec:
  group: $1
  scope: Namespaced
  names: { plural: $2, singular: $(echo "$3" | tr 'A-Z' 'a-z'), kind: $3 }
  versions:
    - name: v1
      served: true
      storage: true
      schema: { openAPIV3Schema: { type: object, x-kubernetes-preserve-unknown-fields: true } }
YAML
}
crd cert-manager.io certificates Certificate
crd velero.io backups Backup
kubectl wait --for=condition=Established crd/certificates.cert-manager.io crd/backups.velero.io --timeout=60s >/dev/null
kubectl apply -f "$WORK/rbac.yaml" >/dev/null
AS=system:serviceaccount:agentic-os:os-ui
fails=0
check() { # expected verb resource namespace
  got=$(kubectl auth can-i "$2" "$3" -n "$4" --as="$AS" 2>/dev/null || true)
  if [ "$got" = "$1" ]; then echo "ok   $1  $2 $3 -n $4"; else echo "FAIL want $1 got ${got:-?}  $2 $3 -n $4"; fails=$((fails+1)); fi
}
# What the run needs.
for v in get list delete; do
  check yes "$v" certificates.cert-manager.io agentic-apps
  check yes "$v" secrets agentic-apps
done
check yes get backups.velero.io velero
check yes list backups.velero.io velero
# Negative twins: nothing more than that.
check no create secrets agentic-apps
check no update secrets agentic-apps
check no delete backups.velero.io velero
check no create backups.velero.io velero
check no delete certificates.cert-manager.io agentic-os
check no get secrets velero
check no get backups.velero.io agentic-os
check no delete secrets kube-system
[ "$fails" = 0 ] || { echo "rbac.kind.sh: $fails check(s) failed"; exit 1; }
echo "rbac.kind.sh: all checks passed"
