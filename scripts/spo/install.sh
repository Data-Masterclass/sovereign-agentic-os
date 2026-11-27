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
#   it to /var/lib/kubelet/seccomp/operator/buildkit-rootless.json on every node, the path the chart's
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

# UNINSTALL, in dependency order (every wait bounded):
#   1. refuse while any pod still uses the profile (set softwareRunner.environments.build.seccomp back to
#      runtime-default / builds off and let running builds finish first): removing a Localhost profile under a running
#      pod breaks its next container start, and a new build pod would fail to start;
#   2. the SeccompProfile (the operator removes the file from every node), then the SPOD (daemon), each with a timeout;
#   3. the operator and, last, its CRDs (the release manifest).
if [ -n "$UNINSTALL" ]; then
  users="$(k get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name} {.spec.securityContext.seccompProfile.localhostProfile}{"\n"}{end}' | grep 'operator/buildkit-rootless.json' || true)"
  if [ -n "$users" ]; then
    echo "refusing to uninstall: these pods still use the profile (turn the localhost seccomp mode off and let them finish):" >&2
    echo "$users" >&2; exit 1
  fi
  k -n "$PROFILE_NS" delete seccompprofile buildkit-rootless --ignore-not-found --wait=true --timeout=120s
  k -n security-profiles-operator delete spod spod --ignore-not-found --wait=true --timeout=180s
  k delete -f "$work/operator.yaml" --ignore-not-found --wait=true --timeout=300s
  echo "security-profiles-operator removed"
  exit 0
fi

# The operator image by digest (the upstream manifest names a tag).
sed -i.bak "s#image: ${SPO_IMAGE}\$#image: ${SPO_IMAGE}@${SPO_IMAGE_DIGEST}#" "$work/operator.yaml"
grep -q "${SPO_IMAGE}@${SPO_IMAGE_DIGEST}" "$work/operator.yaml" || { echo "could not pin the operator image" >&2; exit 1; }
# NOTHING HEAVY MAY START, EVER: the upstream defaults are 3 operator replicas (250m each) and a 3-replica webhook
# (250m each) at PriorityClass system-cluster-critical, which on a full node PREEMPTS platform pods (seen on dev,
# 2026-11-27: dagster, langfuse and os-ui-worker were evicted for a minute). So the operator is applied with 0 replicas,
# its SPOD is written FIRST with `webhook.staticConfig: true` (the operator then creates no webhook at all: profile
# binding/recording, which need it, are not used) and small daemon requests, and only then one small operator starts.
sed -i.bak 's#^  replicas: 3$#  replicas: 0#' "$work/operator.yaml"
grep -q '^  replicas: 0$' "$work/operator.yaml" || { echo "could not set the operator to 0 replicas" >&2; exit 1; }
k apply --server-side --force-conflicts -f "$work/operator.yaml" >/dev/null
k wait --for=condition=Established crd/securityprofilesoperatordaemons.security-profiles-operator.x-k8s.io --timeout=120s >/dev/null
cat <<'YAML' | k apply --server-side --force-conflicts -f - >/dev/null
apiVersion: security-profiles-operator.x-k8s.io/v1
kind: SecurityProfilesOperatorDaemon
metadata:
  name: spod
  namespace: security-profiles-operator
spec:
  enableAppArmor: false
  webhook:
    staticConfig: true
  # The build pod runs on the DEDICATED build pool, tainted soa.dev/build=true:NoSchedule (docs/components/
  # app-builder-build.md), so the daemon must run THERE to write the Localhost profile to that node. Setting
  # tolerations replaces SPO's defaults (control-plane NoSchedule, not-ready NoExecute), so those are repeated.
  # A build pool node that has just scaled up from zero gets the profile when spod starts on it; a build container
  # created before that fails to start and the kubelet retries it until the file exists.
  scheduling:
    tolerations:
      - { key: node-role.kubernetes.io/master, operator: Exists, effect: NoSchedule }
      - { key: node-role.kubernetes.io/control-plane, operator: Exists, effect: NoSchedule }
      - { key: node.kubernetes.io/not-ready, operator: Exists, effect: NoExecute }
      - { key: soa.dev/build, operator: Exists, effect: NoSchedule }
  daemonResourceRequirements:
    requests: { cpu: 10m, memory: 64Mi }
    limits: { cpu: 250m, memory: 256Mi }
YAML
k -n security-profiles-operator patch deployment security-profiles-operator --type=json -p '[
  {"op":"replace","path":"/spec/template/spec/containers/0/resources/requests","value":{"cpu":"10m","memory":"64Mi"}},
  {"op":"replace","path":"/spec/replicas","value":1}]' >/dev/null
k -n security-profiles-operator rollout status deployment/security-profiles-operator --timeout=300s
for _ in $(seq 1 60); do
  st="$(k -n security-profiles-operator get spod spod -o jsonpath='{.status.state}' 2>/dev/null | tr '[:lower:]' '[:upper:]')"
  [ "$st" = RUNNING ] && break; sleep 5
done
k -n security-profiles-operator get spod spod
# A webhook left by an older install of this script: one small replica (staticConfig keeps the operator off it).
if k -n security-profiles-operator get deployment security-profiles-operator-webhook >/dev/null 2>&1; then
  k -n security-profiles-operator scale deployment security-profiles-operator-webhook --replicas=1 >/dev/null
  k -n security-profiles-operator set resources deployment security-profiles-operator-webhook --requests=cpu=5m,memory=32Mi >/dev/null
fi

# The build pod's profile, in the build namespace.
k get namespace "$PROFILE_NS" >/dev/null
node -e '
const spec = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const cr = { apiVersion: "security-profiles-operator.x-k8s.io/v1", kind: "SeccompProfile",
  metadata: { name: "buildkit-rootless", namespace: process.argv[2], labels: { "app.kubernetes.io/part-of": "sovereign-agentic-os" } }, spec };
process.stdout.write(JSON.stringify(cr));' "$root/charts/sovereign-agentic-os/files/seccomp/buildkit-rootless.json" "$PROFILE_NS" \
  | k apply -f - >/dev/null
for _ in $(seq 1 60); do
  [ "$(k -n "$PROFILE_NS" get seccompprofile buildkit-rootless -o jsonpath='{.status.status}' 2>/dev/null)" = Installed ] && break; sleep 5
done
k -n "$PROFILE_NS" get seccompprofile buildkit-rootless -o jsonpath='{.status.status} {.status.localhostProfile}{"\n"}'
