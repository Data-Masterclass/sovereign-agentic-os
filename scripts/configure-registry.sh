#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# Configure the kind node's containerd to pull from Forgejo's in-cluster OCI
# registry over plain HTTP, so CI-built images (push -> Forgejo registry -> Argo)
# can be deployed. Idempotent. Run AFTER the chart is installed (needs the
# forgejo-http Service ClusterIP). See docs/components/ci-build.md.
set -euo pipefail
NODE="${1:-agentic-os-control-plane}"   # kind node container
NS="${2:-agentic-os}"
REG="forgejo-http:3000"

command -v docker >/dev/null || { echo "docker not found"; exit 1; }
docker inspect "$NODE" >/dev/null 2>&1 || { echo "kind node '$NODE' not found"; exit 1; }

# 1) certs.d requires config_path (kind-config.yaml sets it at create time). If a
#    cluster was created without it, patch config.toml + restart containerd once.
if ! docker exec "$NODE" grep -q 'certs.d' /etc/containerd/config.toml 2>/dev/null; then
  echo "==> adding containerd config_path (one-time) + restarting containerd"
  docker exec "$NODE" sh -c 'cat >> /etc/containerd/config.toml <<EOF

[plugins."io.containerd.grpc.v1.cri".registry]
  config_path = "/etc/containerd/certs.d"
EOF'
  docker exec "$NODE" systemctl restart containerd
  sleep 6
fi

# 2) per-registry hosts.toml (plain HTTP, skip TLS verify) — read dynamically.
echo "==> writing certs.d/$REG/hosts.toml"
docker exec "$NODE" sh -c "mkdir -p '/etc/containerd/certs.d/$REG' && cat > '/etc/containerd/certs.d/$REG/hosts.toml' <<EOF
server = \"http://$REG\"
[host.\"http://$REG\"]
  capabilities = [\"pull\", \"resolve\"]
  skip_verify = true
EOF"

# 3) make 'forgejo-http' resolvable on the node (containerd uses the node
#    resolver, not cluster DNS; kube-proxy makes the ClusterIP reachable).
CIP="$(kubectl -n "$NS" get svc forgejo-http -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)"
if [ -n "$CIP" ]; then
  docker exec "$NODE" sh -c "sed -i '/ forgejo-http\$/d' /etc/hosts; echo '$CIP forgejo-http' >> /etc/hosts"
  echo "==> /etc/hosts: $CIP forgejo-http"
else
  echo "WARN: forgejo-http Service not found in ns/$NS — run this after 'helm install'."
fi
echo "Registry pull configured for $REG on node '$NODE'."
