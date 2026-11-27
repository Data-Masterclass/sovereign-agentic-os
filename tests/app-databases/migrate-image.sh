#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# FEATURE: App Builder app databases (workstream D) - a release-shaped image for the migrate-hook test.
# USER STORY: As the owner I want the migrate Job proven with the template's own Dockerfile stage and the platform's
#   fixed command, from an image pulled by digest, as in a real release.
# ARCHITECTURE: instantiates `nextjs-web@2` exactly as `createApp` seeds it (golden-path.ts goldenPathFiles: template,
#   vendored SDK, scope pin), builds its Dockerfile with `--target <stage>` (default `migrate`: the layout under
#   /app/migrate is the one the run image copies; `run` builds the whole app), pushes it to a local registry the kind
#   node pulls from (kind's documented local-registry setup: containerd hosts.toml for localhost:5001), and prints the
#   `localhost:5001/appdb-migrate@sha256:…` reference.
#   Usage: DOCKER_HOST=… bash tests/app-databases/migrate-image.sh <kind-cluster-name> [migrate|run]
set -euo pipefail
CLUSTER="${1:?kind cluster name}"; TARGET="${2:-migrate}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
if [ -z "$(docker ps -q -f name=^kind-registry$)" ]; then
  docker run -d --restart=always -p 127.0.0.1:5001:5000 --network kind --name kind-registry registry:2 >/dev/null
fi
node_c="${CLUSTER}-control-plane"
docker exec "$node_c" mkdir -p /etc/containerd/certs.d/localhost:5001
printf '[host."http://kind-registry:5000"]\n' | docker exec -i "$node_c" sh -c 'cat > /etc/containerd/certs.d/localhost:5001/hosts.toml'
(cd "$root/os-ui" && GOLDEN_PATH_TEMPLATES_DIR="$root/templates" node --experimental-strip-types --no-warnings --import ./scripts/test-setup.mjs -e '
  const { goldenPathFiles } = await import("./tabs/software/lib/golden-path.ts");
  const fs = await import("node:fs"); const path = await import("node:path");
  for (const f of goldenPathFiles("nextjs-web", { name: "Migrate Test", slug: "migrate-test" }, 2)) {
    const p = path.join(process.argv[1], f.path); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.content);
  }' "$work")
docker build -q --target "$TARGET" -t "localhost:5001/appdb-$TARGET:test" "$work" >/dev/null
digest="$(docker push "localhost:5001/appdb-$TARGET:test" | sed -n 's/.*digest: \(sha256:[0-9a-f]\{64\}\).*/\1/p')"
[ -n "$digest" ] || { echo "push gave no digest" >&2; exit 1; }
echo "localhost:5001/appdb-$TARGET@$digest"
