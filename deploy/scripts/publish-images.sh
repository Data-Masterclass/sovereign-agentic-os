#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# publish-images.sh — build the bespoke Sovereign OS images and push them to the
# STACKIT Container Registry, then record each immutable digest into the Mode B
# overlay (REPLACE-*-DIGEST). kind's local image load does NOT work on a real
# cluster (build-deploy §4), so production pulls from the registry by digest.
#
# SAFE BY DEFAULT: dry-run unless --push is given. Never run for real in the build
# phase — this is a go-live step (needs registry auth + cost sign-off).
#
# Usage:
#   deploy/scripts/publish-images.sh [--push] [--registry HOST/NS]
set -euo pipefail

PUSH=0
REGISTRY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --push) PUSH=1; shift ;;
    --registry) REGISTRY="$2"; shift 2 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OVERLAY="$ROOT/values.stackit-managed.yaml"

# Resolve the registry from terraform output if not passed.
if [[ -z "$REGISTRY" ]]; then
  TF="$(command -v terraform || command -v tofu || true)"
  [[ -n "$TF" ]] && REGISTRY="$("$TF" -chdir="$ROOT/deploy/terraform" output -raw container_registry_url 2>/dev/null || true)"
fi
[[ -z "$REGISTRY" ]] && REGISTRY="REPLACE-registry-host/agentic-os"

# image dir : tag : overlay-digest-token  (context = images/<dir> unless noted)
IMAGES="
agent-runtime:0.1.0:REPLACE-AGENT-RUNTIME-DIGEST
mock-model:0.1.1:REPLACE-MOCK-MODEL-DIGEST
sample-agent:0.1.0:REPLACE-SAMPLE-AGENT-DIGEST
haystack-retriever:0.1.0:REPLACE-HAYSTACK-DIGEST
dbt:0.2.0:REPLACE-DBT-DIGEST
egress-proxy:0.1.0:REPLACE-EGRESS-PROXY-DIGEST
web-fetch:0.1.0:REPLACE-WEB-FETCH-DIGEST
query-tool:0.3.0:REPLACE-QUERY-TOOL-DIGEST
sandbox-duckdb:0.1.0:REPLACE-SANDBOX-DUCKDB-DIGEST
superset:6.1.0:REPLACE-SUPERSET-DIGEST
mlflow:2.19.0:REPLACE-MLFLOW-DIGEST
ml-agent:0.1.0:REPLACE-ML-AGENT-DIGEST
terminal-broker:0.1.0:REPLACE-TERMINAL-BROKER-DIGEST
sandbox-shell:0.1.0:REPLACE-SANDBOX-SHELL-DIGEST
workbench-broker:0.1.0:REPLACE-WORKBENCH-BROKER-DIGEST
code-server-workbench:0.1.0:REPLACE-CODE-SERVER-WORKBENCH-DIGEST
"

record_digest() {
  local token="$1" digest="$2"
  [[ -z "$digest" ]] && return
  sed -i.bak "s|$token|${digest#sha256:}|g" "$OVERLAY" && rm -f "$OVERLAY.bak"
  echo "    recorded $token -> $digest"
}

build_push() {
  local dir="$1" tag="$2" token="$3"
  local ref="$REGISTRY/sovereign-os/$dir:$tag"
  echo "==> $ref  (context=images/$dir)"
  if [[ $PUSH -eq 0 ]]; then
    echo "    DRY-RUN: docker build -t $ref images/$dir && docker push $ref"
    return
  fi
  docker build -t "$ref" "images/$dir"
  docker push "$ref"
  local digest
  digest="$(docker inspect --format='{{index .RepoDigests 0}}' "$ref" | sed 's/.*@//')"
  record_digest "$token" "$digest"
}

for e in $IMAGES; do
  IFS=':' read -r dir tag token <<<"$e"
  build_push "$dir" "$tag" "$token"
done

# Special build contexts (mirror scripts/build-images.sh). The OS UI now builds
# from the repo root so it can bake in docs/components/* for the native
# Components surface. admin-console is DEPRECATED (its function is native to the
# OS UI) — build it only for the legacy standalone service.
for spec in \
  "dagster:0.2.0:REPLACE-DAGSTER-DIGEST:-f images/dagster/Dockerfile images/" \
  "os-ui:0.1.0:REPLACE-OS-UI-DIGEST:-f images/os-ui/Dockerfile ."
do
  IFS=':' read -r name tag token ctx <<<"$spec"
  ref="$REGISTRY/sovereign-os/$name:$tag"
  echo "==> $ref  (context: $ctx)"
  if [[ $PUSH -eq 0 ]]; then
    echo "    DRY-RUN: docker build -t $ref $ctx && docker push $ref"
    continue
  fi
  # shellcheck disable=SC2086
  docker build -t "$ref" $ctx
  docker push "$ref"
  digest="$(docker inspect --format='{{index .RepoDigests 0}}' "$ref" | sed 's/.*@//')"
  record_digest "$token" "$digest"
done

echo "Done ($([[ $PUSH -eq 1 ]] && echo pushed+recorded || echo dry-run)). Registry: $REGISTRY"
