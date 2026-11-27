#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# FEATURE: App Builder build platform (workstream C1) - the APPROVED seccomp fallback, dev only.
# USER STORY: As the platform owner I want the build pod's Localhost seccomp profile distributed to every node by a
#   pinned upstream operator, installed by one documented command, so no node is ever edited by hand.
# ARCHITECTURE: security-profiles-operator (Apache-2.0), installed exactly as upstream documents it
#   (https://github.com/kubernetes-sigs/security-profiles-operator/blob/main/installation-usage.md): its release
#   manifest, sha256-checked against scripts/spo/versions.env, with three install-time settings: the operator image
#   pinned by digest, ONE operator replica and small requests (the dev node is CPU-bound, plan "Dev capacity"), and the
#   SPOD daemon's requests via its own `SecurityProfilesOperatorDaemon` resource. Then the build pod's profile
#   (charts/.../files/seccomp/buildkit-rootless.json) is applied as a SeccompProfile in the operator namespace; SPO writes
#   it to /var/lib/kubelet/seccomp/operator/security-profiles-operator/buildkit-rootless.json on every node, the path the chart's
#   `osUI.software.build.seccomp: localhost` refers to. Needs cert-manager (SPO's webhook certificate).
#
# Usage (explicit kubeconfig, never the current context):
#   bash scripts/spo/install.sh --kubeconfig <file> [--profile-namespace security-profiles-operator]
# Undo: bash scripts/spo/install.sh --kubeconfig <file> --uninstall
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# shellcheck source=/dev/null
. "$here/versions.env"
KCFG=""; PROFILE_NS="security-profiles-operator"; UNINSTALL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --kubeconfig) KCFG="$2"; shift 2 ;;
    --profile-namespace) PROFILE_NS="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$KCFG" ] || { echo "--kubeconfig is required (this script never uses the current context)" >&2; exit 2; }
k() { kubectl --kubeconfig "$KCFG" "$@"; }
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
curl -fsSL "$SPO_MANIFEST_URL" -o "$work/operator.yaml"
got="$( (sha256sum "$work/operator.yaml" 2>/dev/null || shasum -a 256 "$work/operator.yaml") | cut -d' ' -f1)"
[ "$got" = "$SPO_MANIFEST_SHA256" ] || { echo "SPO manifest sha256 $got != pinned $SPO_MANIFEST_SHA256" >&2; exit 1; }

if [ -n "$UNINSTALL" ]; then
  k -n "$PROFILE_NS" delete seccompprofile buildkit-rootless --ignore-not-found --wait=true || true
  k -n security-profiles-operator delete spod spod --ignore-not-found --wait=true || true
  k delete -f "$work/operator.yaml" --ignore-not-found --wait=true
  echo "security-profiles-operator removed"
  exit 0
fi

# The operator image by digest (the upstream manifest names a tag).
sed -i.bak "s#image: ${SPO_IMAGE}\$#image: ${SPO_IMAGE}@${SPO_IMAGE_DIGEST}#" "$work/operator.yaml"
grep -q "${SPO_IMAGE}@${SPO_IMAGE_DIGEST}" "$work/operator.yaml" || { echo "could not pin the operator image" >&2; exit 1; }
k apply --server-side --force-conflicts -f "$work/operator.yaml" >/dev/null
# One replica and small requests: profile distribution is not on any request path.
k -n security-profiles-operator patch deployment security-profiles-operator --type=json -p '[
  {"op":"replace","path":"/spec/replicas","value":1},
  {"op":"replace","path":"/spec/template/spec/containers/0/resources/requests","value":{"cpu":"10m","memory":"64Mi"}}]' >/dev/null
k -n security-profiles-operator rollout status deployment/security-profiles-operator --timeout=300s
# The operator creates the default SPOD (daemon + webhook); wait for it, then size it.
for _ in $(seq 1 60); do k -n security-profiles-operator get spod spod >/dev/null 2>&1 && break; sleep 5; done
k -n security-profiles-operator patch spod spod --type=merge -p '{"spec":{"enableAppArmor":false,"enableSelinux":false,"daemonResourceRequirements":{"requests":{"cpu":"10m","memory":"64Mi"},"limits":{"cpu":"250m","memory":"256Mi"}}}}' >/dev/null
for _ in $(seq 1 60); do
  [ "$(k -n security-profiles-operator get spod spod -o jsonpath='{.status.state}' 2>/dev/null)" = RUNNING ] && break; sleep 5
done
k -n security-profiles-operator get spod spod
# Webhook replicas: SPO sizes its own webhook Deployment; one is enough here.
if k -n security-profiles-operator get deployment security-profiles-operator-webhook >/dev/null 2>&1; then
  k -n security-profiles-operator scale deployment security-profiles-operator-webhook --replicas=1 >/dev/null
  k -n security-profiles-operator set resources deployment security-profiles-operator-webhook --requests=cpu=5m,memory=32Mi >/dev/null || true
fi

# The build pod's profile, in the build namespace.
k get namespace "$PROFILE_NS" >/dev/null
node -e '
const spec = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const cr = { apiVersion: "security-profiles-operator.x-k8s.io/v1beta1", kind: "SeccompProfile",
  metadata: { name: "buildkit-rootless", namespace: process.argv[2], labels: { "app.kubernetes.io/part-of": "sovereign-agentic-os" } }, spec };
process.stdout.write(JSON.stringify(cr));' "$root/charts/sovereign-agentic-os/files/seccomp/buildkit-rootless.json" "$PROFILE_NS" \
  | k apply -f - >/dev/null
for _ in $(seq 1 60); do
  [ "$(k -n "$PROFILE_NS" get seccompprofile buildkit-rootless -o jsonpath='{.status.status}' 2>/dev/null)" = Installed ] && break; sleep 5
done
k -n "$PROFILE_NS" get seccompprofile buildkit-rootless -o jsonpath='{.status.status} {.status.localhostProfile}{"\n"}'
