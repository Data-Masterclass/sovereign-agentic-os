#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# FEATURE: App Builder app databases (workstream D) - the CloudNativePG operator, installed as a pinned platform
#   component.
# USER STORY: As the platform owner I want the database operator installed by one documented, reversible command,
#   pinned and checksum-verified, small enough for the dev node, never preempting a platform pod.
# ARCHITECTURE: CloudNativePG (Apache-2.0) exactly as upstream documents it
#   (https://cloudnative-pg.io/documentation/current/installation_upgrade/): its release manifest, sha256-checked
#   against scripts/cnpg/versions.env, with install-time settings only:
#     - the operator image pinned by digest (both the container and OPERATOR_IMAGE_NAME, which the operator injects
#       into every instance pod as the bootstrap init container), imagePullPolicy IfNotPresent;
#     - applied with 0 replicas FIRST, then configured (small requests, optional non-preempting PriorityClass), then
#       scaled to 1: nothing heavy ever starts on a full node (the upstream default is 100m at the default priority);
#     - a capacity guard: refuses when the cluster's CPU requests plus the operator's would exceed
#       CNPG_MAX_CPU_REQUEST_PERCENT (85) of allocatable CPU; prints the numbers before and after.
#   The app database Clusters themselves are NOT installed here: the chart renders them
#   (templates/base/os-ui/software-app-databases.yaml) when softwareRunner.environments.enabled and
#   osUI.software.databases.mode=cnpg, with an operand image the owner chose.
#
# Usage (explicit kubeconfig, never the current context):
#   bash scripts/cnpg/install.sh --kubeconfig <file> [--priority-class <name>]
# Undo: bash scripts/cnpg/install.sh --kubeconfig <file> --uninstall
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$here/versions.env"
KCFG=""; UNINSTALL=""; PRIORITY_CLASS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --kubeconfig) KCFG="$2"; shift 2 ;;
    --priority-class) PRIORITY_CLASS="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$KCFG" ] || { echo "--kubeconfig is required (this script never uses the current context)" >&2; exit 2; }
[ -f "$KCFG" ] || { echo "kubeconfig $KCFG does not exist" >&2; exit 2; }
k() { kubectl --kubeconfig "$KCFG" "$@"; }
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
curl -fsSL "$CNPG_MANIFEST_URL" -o "$work/cnpg.yaml"
got="$( (sha256sum "$work/cnpg.yaml" 2>/dev/null || shasum -a 256 "$work/cnpg.yaml") | cut -d' ' -f1)"
[ "$got" = "$CNPG_MANIFEST_SHA256" ] || { echo "CNPG manifest sha256 $got != pinned $CNPG_MANIFEST_SHA256" >&2; exit 1; }

# CPU requests of every scheduled, unfinished pod against allocatable CPU, cluster-wide (millicores). Prints "<req> <alloc>".
cpu_requests() {
  k get nodes -o json >"$work/nodes.json"
  k get pods -A --field-selector=status.phase!=Succeeded,status.phase!=Failed -o json >"$work/pods.json"
  node -e '
    const fs = require("fs");
    const m = (q) => { if (!q) return 0; q = String(q); return q.endsWith("m") ? Number(q.slice(0, -1)) : Number(q) * 1000; };
    const nodes = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).items;
    const pods = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).items.filter((p) => p.spec.nodeName);
    const alloc = nodes.reduce((s, n) => s + m(n.status.allocatable.cpu), 0);
    // A pod requests max(sum of containers, largest init container) plus its overhead (the scheduler rule).
    const req = pods.reduce((s, p) => {
      const c = (p.spec.containers || []).reduce((a, x) => a + m(((x.resources || {}).requests || {}).cpu), 0);
      const i = Math.max(0, ...(p.spec.initContainers || []).filter((x) => x.restartPolicy !== "Always").map((x) => m(((x.resources || {}).requests || {}).cpu)));
      const side = (p.spec.initContainers || []).filter((x) => x.restartPolicy === "Always").reduce((a, x) => a + m(((x.resources || {}).requests || {}).cpu), 0);
      return s + Math.max(c + side, i) + m(((p.spec.overhead || {}).cpu));
    }, 0);
    process.stdout.write(`${req} ${alloc}\n`);' "$work/nodes.json" "$work/pods.json"
}
pct() { node -e 'process.stdout.write((100 * Number(process.argv[1]) / Number(process.argv[2])).toFixed(1))' "$1" "$2"; }

# UNINSTALL, in dependency order (every wait bounded): refuse while any CNPG Cluster still exists (deleting the CRDs
# would delete every database with them: remove the Clusters deliberately first, by switching
# osUI.software.databases.mode off in the chart, and keep their PVCs if you need the data), then the release manifest
# (operator, webhooks, RBAC, CRDs).
if [ -n "$UNINSTALL" ]; then
  if k get crd clusters.postgresql.cnpg.io >/dev/null 2>&1; then
    left="$(k get clusters.postgresql.cnpg.io -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}')"
    if [ -n "$left" ]; then
      echo "refusing to uninstall: these CNPG Clusters still exist (removing the CRDs would delete them and their databases):" >&2
      echo "$left" >&2; exit 1
    fi
  fi
  k delete -f "$work/cnpg.yaml" --ignore-not-found --wait=true --timeout=300s
  echo "CloudNativePG operator removed"
  exit 0
fi

# The chart's os-ui admission policy compares every Cluster/Database .spec property it knows
# (charts/sovereign-agentic-os/files/cnpg/*-spec-fields.txt): an operator whose CRDs carry a property missing there would
# let os-ui change it unchecked, so it is refused before anything is applied.
kubectl create --dry-run=client -o json -f "$work/cnpg.yaml" >"$work/cnpg.json"
node "$here/check-crd-fields.mjs" "$work/cnpg.json" "$here/../../charts/sovereign-agentic-os/files/cnpg"

read -r before alloc < <(cpu_requests)
op_m="${CNPG_OPERATOR_CPU_REQUEST%m}"
already="$(k -n cnpg-system get deployment cnpg-controller-manager -o jsonpath='{.spec.replicas}' 2>/dev/null || true)"
extra="$op_m"; [ "${already:-0}" -ge 1 ] && extra=0
# The app database instances it is installed for, unless some already run (then they are in the requests above).
existing="$( (k get clusters.postgresql.cnpg.io -A --no-headers 2>/dev/null || true) | wc -l | tr -d ' ')"
[ "${existing:-0}" -eq 0 ] && extra=$((extra + ${CNPG_PLANNED_CLUSTER_CPU%m}))
echo "capacity before: CPU requests ${before}m of ${alloc}m allocatable ($(pct "$before" "$alloc")%); the operator and planned app database instances add ${extra}m"
over="$(node -e 'process.stdout.write(String(100 * (Number(process.argv[1]) + Number(process.argv[2])) > Number(process.argv[3]) * Number(process.argv[4])))' "$before" "$extra" "$CNPG_MAX_CPU_REQUEST_PERCENT" "$alloc")"
if [ "$over" = true ]; then
  echo "refusing to install: CPU requests would exceed ${CNPG_MAX_CPU_REQUEST_PERCENT}% of allocatable CPU" >&2; exit 1
fi
if [ -n "$PRIORITY_CLASS" ]; then
  policy="$(k get priorityclass "$PRIORITY_CLASS" -o jsonpath='{.preemptionPolicy}')"
  [ "$policy" = Never ] || { echo "PriorityClass $PRIORITY_CLASS preempts (preemptionPolicy=$policy); only a class with preemptionPolicy Never is allowed" >&2; exit 1; }
fi

# The operator image by digest (the upstream manifest names a tag), in the container AND in OPERATOR_IMAGE_NAME.
sed -i.bak "s#${CNPG_IMAGE}\$#${CNPG_IMAGE}@${CNPG_IMAGE_DIGEST}#" "$work/cnpg.yaml"
[ "$(grep -c "${CNPG_IMAGE}@${CNPG_IMAGE_DIGEST}" "$work/cnpg.yaml")" = 2 ] || { echo "could not pin the operator image (expected 2 references)" >&2; exit 1; }
sed -i.bak 's#imagePullPolicy: Always#imagePullPolicy: IfNotPresent#' "$work/cnpg.yaml"
# The small requests are written into the manifest itself, so a re-run never rolls the operator to the upstream 100m.
perl -0pi -e "s#requests:\n            cpu: 100m\n            memory: 100Mi#requests:\n            cpu: ${CNPG_OPERATOR_CPU_REQUEST}\n            memory: ${CNPG_OPERATOR_MEMORY_REQUEST}#" "$work/cnpg.yaml"
grep -q "cpu: ${CNPG_OPERATOR_CPU_REQUEST}\$" "$work/cnpg.yaml" || { echo "could not size the operator" >&2; exit 1; }
# Applied with ZERO replicas: nothing starts before it is sized.
sed -i.bak 's#^  replicas: 1$#  replicas: 0#' "$work/cnpg.yaml"
[ "$(grep -c '^  replicas: 0$' "$work/cnpg.yaml")" = 1 ] || { echo "could not set the operator to 0 replicas" >&2; exit 1; }
if [ "${already:-0}" -ge 1 ]; then
  # Re-running on a live install: keep it running (the patch below re-asserts the sizing).
  sed -i.bak 's#^  replicas: 0$#  replicas: 1#' "$work/cnpg.yaml"
fi
k apply --server-side --force-conflicts -f "$work/cnpg.yaml" >/dev/null
k wait --for=condition=Established crd/clusters.postgresql.cnpg.io crd/databases.postgresql.cnpg.io --timeout=120s >/dev/null
patch='[{"op":"replace","path":"/spec/template/spec/containers/0/resources/requests","value":{"cpu":"'"$CNPG_OPERATOR_CPU_REQUEST"'","memory":"'"$CNPG_OPERATOR_MEMORY_REQUEST"'"}}'
if [ -n "$PRIORITY_CLASS" ]; then
  patch="$patch"',{"op":"add","path":"/spec/template/spec/priorityClassName","value":"'"$PRIORITY_CLASS"'"}'
fi
patch="$patch"',{"op":"replace","path":"/spec/replicas","value":1}]'
k -n cnpg-system patch deployment cnpg-controller-manager --type=json -p "$patch" >/dev/null
k -n cnpg-system rollout status deployment/cnpg-controller-manager --timeout=300s
read -r after alloc < <(cpu_requests)
echo "capacity after: CPU requests ${after}m of ${alloc}m allocatable ($(pct "$after" "$alloc")%)"
k -n cnpg-system get deployment cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].image} requests={.spec.template.spec.containers[0].resources.requests} priorityClass={.spec.template.spec.priorityClassName}{"\n"}'
