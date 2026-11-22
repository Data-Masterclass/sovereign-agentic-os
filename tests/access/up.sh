#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# FEATURE:    Harness for the access-rules drift proof
# USER STORY: As a platform admin I want the proof that a foreign edit of the Trino rules is repaired and
#             reported to run on a real API server, not a fake.
# ARCHITECTURE:
#   A kind cluster (its OWN kubeconfig, never ~/.kube/config) holding the chart's real `trino-access-rules`
#   ConfigMap (rendered and applied as is), a ServiceAccount allowed to read and patch only that
#   ConfigMap, and its token and CA in the layout core/infra/k8s.ts reads.
#
# Harness for the access-rules drift proof: a kind cluster (its OWN kubeconfig, never
# ~/.kube/config) holding the chart's real `trino-access-rules` ConfigMap (rendered from the chart and
# applied as is), a ServiceAccount allowed to read and patch only that ConfigMap, and its token and
# CA in the layout core/infra/k8s.ts reads (OS_K8S_SA_DIR, KUBERNETES_API).
#
#   bash tests/access/up.sh && (cd os-ui && node --experimental-test-module-mocks --import ./scripts/test-setup.mjs \
#       --test ../tests/access/rules-drift.int.test.ts)
#   bash tests/access/down.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
KIND_NAME=${ACCESS_KIND:-own-access}
H=${ACCESS_WORK:-${TMPDIR:-/tmp}/own-access-work}
mkdir -p "$H/sa"
export KUBECONFIG="$H/kubeconfig"
kind get clusters 2>/dev/null | grep -qx "$KIND_NAME" || kind create cluster --name "$KIND_NAME" --kubeconfig "$KUBECONFIG" --wait 120s >/dev/null
K="kubectl --kubeconfig $KUBECONFIG"
$K create namespace agentic-os --dry-run=client -o yaml | $K apply -f - >/dev/null
# The chart's own ConfigMap (bootstrap rules), as rendered.
helm template agentic-os charts/sovereign-agentic-os -n agentic-os --skip-schema-validation -f tests/lakehouse/ci-values.yaml \
  --show-only templates/extensions/lakehouse/trino.yaml > "$H/trino.yaml"
python3 - "$H/trino.yaml" > "$H/rules-cm.yaml" <<'PY'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d and d.get("kind") == "ConfigMap" and d["metadata"]["name"] == "trino-access-rules"]
assert len(docs) == 1, "the chart renders exactly one trino-access-rules ConfigMap"
print(yaml.safe_dump(docs[0]))
PY
$K apply -f "$H/rules-cm.yaml" >/dev/null
$K -n agentic-os create serviceaccount os-ui --dry-run=client -o yaml | $K apply -f - >/dev/null
$K apply -f - >/dev/null <<'YAML'
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: os-ui-trino-rules, namespace: agentic-os }
rules:
  - apiGroups: [""]
    resources: [configmaps]
    resourceNames: [trino-access-rules]
    verbs: [get, patch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: os-ui-trino-rules, namespace: agentic-os }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: os-ui-trino-rules }
subjects: [{ kind: ServiceAccount, name: os-ui, namespace: agentic-os }]
YAML
( umask 077
  $K -n agentic-os create token os-ui --duration 2h > "$H/sa/token"
  $K config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d > "$H/sa/ca.crt"
  $K config view --raw --minify -o jsonpath='{.clusters[0].cluster.server}' > "$H/api"
  printf 'OS_K8S_SA_DIR=%s\nKUBERNETES_API=%s\nACCESS_KUBECONFIG=%s\n' "$H/sa" "$(cat "$H/api")" "$KUBECONFIG" > "$H/env"
)
echo "$H/env"
