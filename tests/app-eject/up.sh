#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# WP-54 eject harness: a kind cluster + a local OCI registry (CNCF Distribution) that stands in for
# the platform registry, wired with kind's documented local-registry pattern
# (https://kind.sigs.k8s.io/docs/user/local-registry/). Nothing of the OS is installed.
#
# Uses its OWN kubeconfig file ($APP_EJECT_KUBECONFIG); never writes ~/.kube/config.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/../e2e/kind/versions.env"
: "${APP_EJECT_CLUSTER:=app-eject}"
: "${APP_EJECT_KUBECONFIG:?set APP_EJECT_KUBECONFIG to a file of its own}"
REG_NAME="${APP_EJECT_CLUSTER}-registry"
REG_PORT="${APP_EJECT_REGISTRY_PORT:-5001}"
REG_IMAGE="registry:3.0.0"

if [ "$(docker inspect -f '{{.State.Running}}' "$REG_NAME" 2>/dev/null || true)" != 'true' ]; then
  docker run -d --restart=no -p "127.0.0.1:${REG_PORT}:5000" --network bridge --name "$REG_NAME" "$REG_IMAGE" >/dev/null
fi

cat <<YAML | kind create cluster --name "$APP_EJECT_CLUSTER" --image "$KIND_NODE_IMAGE" --kubeconfig "$APP_EJECT_KUBECONFIG" --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
containerdConfigPatches:
  - |-
    [plugins."io.containerd.grpc.v1.cri".registry]
      config_path = "/etc/containerd/certs.d"
YAML

dir="/etc/containerd/certs.d/localhost:${REG_PORT}"
for node in $(kind get nodes --name "$APP_EJECT_CLUSTER"); do
  docker exec "$node" mkdir -p "$dir"
  printf '[host."http://%s:5000"]\n' "$REG_NAME" | docker exec -i "$node" cp /dev/stdin "$dir/hosts.toml"
done
if [ "$(docker inspect -f='{{json .NetworkSettings.Networks.kind}}' "$REG_NAME")" = 'null' ]; then
  docker network connect kind "$REG_NAME"
fi
KUBECONFIG="$APP_EJECT_KUBECONFIG" kubectl wait --for=condition=Ready node --all --timeout=180s >/dev/null
echo "app-eject: cluster ${APP_EJECT_CLUSTER} up, registry localhost:${REG_PORT}"
