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
#   - the manifest scripts/dev/manifests/ci-rbac.yaml: everything in agentic-os and agentic-apps,
#     PriorityClasses, read on namespaces and nodes, the marker — and nothing else;
#   - Pod Security Admission (manifests/namespaces.yaml: baseline enforced on agentic-os) refuses
#     privileged, hostPath and host-namespace pods there, whoever creates them.
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
# Namespaces with their Pod Security labels first (operator-owned), then the account.
k apply -f "$REPO_ROOT/scripts/dev/manifests/namespaces.yaml" >/dev/null
k apply -f "$REPO_ROOT/scripts/dev/manifests/ci-rbac.yaml" >/dev/null
# Proof, from the API server itself: the CI account cannot read the model key.
SA=system:serviceaccount:sovereign-os-ci:sovereign-os-ci
if k auth can-i get secret/stackit-model-key -n dev-model-key --as "$SA" >/dev/null 2>&1; then
  die "the CI account CAN read dev-model-key/stackit-model-key — refusing to hand out this credential"
fi
echo "   checked: $SA cannot get secrets in dev-model-key"
for probe in "create pods -n kube-system" "patch namespace/agentic-os" "update namespaces" "create pods -n dev-model-key"; do
  # shellcheck disable=SC2086  # the probe is a verb and a resource, split on purpose
  if k auth can-i $probe --as "$SA" >/dev/null 2>&1; then
    die "the CI account can '$probe' — refusing to hand out this credential"
  fi
done
echo "   checked: $SA cannot create pods in kube-system or dev-model-key, nor change namespace labels"
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
