#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# render-values.sh — fill the mode overlay + Argo manifests' REPLACE-… tokens
# from `terraform output`, and point the OS Application (apps/10) at the right
# value files for the chosen MODE. Endpoints/registry/DNS only (NOT secrets —
# those go to Secrets Manager via push-secrets.sh). Idempotent; supports --dry-run.
#
#   MODE=selfhosted (Mode A) — bundled backends on SKE. Fills ONLY REPLACE-DNS-NAME
#                              in values.stackit-selfhosted.yaml (from `dns_name`)
#                              and sets apps/10 valueFiles to
#                              values.selfcontained.yaml + values.stackit-selfhosted.yaml.
#   MODE=managed    (Mode B) — STACKIT managed backends. Fills the endpoint/registry/
#                              DNS tokens in values.stackit-managed.yaml (+ ESO/Velero)
#                              and sets apps/10 valueFiles to values.stackit-managed.yaml.
#
# Usage:
#   deploy/scripts/render-values.sh [--dry-run] [--mode selfhosted|managed]
#   MODE=selfhosted deploy/scripts/render-values.sh
# Run from anywhere; paths are resolved relative to the repo root.
set -euo pipefail

DRY_RUN=0
MODE="${MODE:-managed}"   # default preserves Mode B behaviour for bare invocations
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --mode)    MODE="${2:?--mode needs a value}"; shift ;;
    --mode=*)  MODE="${1#*=}" ;;
    selfhosted|managed) MODE="$1" ;;   # bare positional for convenience
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$MODE" == "selfhosted" || "$MODE" == "managed" ]] || { echo "MODE must be selfhosted|managed (got '$MODE')"; exit 2; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TF_DIR="$ROOT/deploy/terraform"
OVERLAY_MANAGED="$ROOT/values.stackit-managed.yaml"
OVERLAY_SELFHOSTED="$ROOT/values.stackit-selfhosted.yaml"
CSS="$ROOT/deploy/argocd/secrets/cluster-secret-store.yaml"
VELERO="$ROOT/deploy/argocd/apps/05-velero.yaml"
APP10="$ROOT/deploy/argocd/apps/10-sovereign-agentic-os.yaml"

command -v jq >/dev/null || { echo "jq required"; exit 1; }
TF="$(command -v terraform || command -v tofu)" || { echo "terraform/tofu required"; exit 1; }

echo "==> reading terraform outputs (MODE=$MODE)"
OUT="$("$TF" -chdir="$TF_DIR" output -json)"
get() { echo "$OUT" | jq -r ".${1}.value // empty"; }

DNS_NAME="$(get dns_name)"

# token -> value -> file(s), assembled per MODE.
declare -a SUBS=()
if [[ "$MODE" == "selfhosted" ]]; then
  # Mode A: bundled backends — the ONLY token is the public DNS suffix.
  SUBS=( "REPLACE-DNS-NAME|$DNS_NAME|$OVERLAY_SELFHOSTED" )
else
  # Mode B: managed endpoints/registry/DNS (+ ESO/Velero).
  PG_HOST="$(get postgres_host)"
  OS_HOST="$(get opensearch_host)"
  MS_URL="$(get model_serving_base_url)"
  REGISTRY="$(get container_registry_url)"
  SM_ID="$(get secretsmanager_instance_id)"
  ESO_USER="$(get secretsmanager_eso_username)"   # sensitive — only the username
  VELERO_BUCKET="$(echo "$OUT" | jq -r '.object_storage_buckets.value.velero // empty')"
  SUBS=(
    "REPLACE-postgres-flex-host|$PG_HOST|$OVERLAY_MANAGED"
    "REPLACE-opensearch-host|$OS_HOST|$OVERLAY_MANAGED"
    "REPLACE-model-serving-base-url|$MS_URL|$OVERLAY_MANAGED"
    "REPLACE-REGISTRY|$REGISTRY|$OVERLAY_MANAGED"
    "REPLACE-DNS-NAME|$DNS_NAME|$OVERLAY_MANAGED"
    "REPLACE-sm-instance-id|$SM_ID|$CSS"
    "REPLACE-eso-username|$ESO_USER|$CSS"
    "REPLACE-velero-bucket|$VELERO_BUCKET|$VELERO"
  )
fi

apply_sub() {
  local token="$1" value="$2" file="$3"
  [[ -z "$value" ]] && { echo "  SKIP $token (no output)"; return; }
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  would set $token -> $value  ($(basename "$file"))"
  else
    # `|` delimiter; values may contain / and : but not |.
    sed -i.bak "s|$token|$value|g" "$file" && rm -f "$file.bak"
    echo "  set $token -> $value  ($(basename "$file"))"
  fi
}

# Rewrite the MODE-VALUEFILES block in apps/10 so Argo loads the right overlay(s).
# Idempotent + reversible (works no matter which mode the file is currently in).
rewrite_valuefiles() {
  local mode="$1"
  python3 - "$APP10" "$mode" "$DRY_RUN" <<'PY'
import re, sys
path, mode, dry = sys.argv[1], sys.argv[2], sys.argv[3]
files = (["values.selfcontained.yaml", "values.stackit-selfhosted.yaml"]
         if mode == "selfhosted" else ["values.stackit-managed.yaml"])
with open(path) as fh:
    text = fh.read()
m = re.search(r"(?ms)^([ \t]*)# >>> MODE-VALUEFILES.*?\n.*?^[ \t]*# <<< MODE-VALUEFILES[ \t]*$", text)
if not m:
    sys.exit("MODE-VALUEFILES markers not found in %s" % path)
indent = m.group(1)
lines = [f"{indent}# >>> MODE-VALUEFILES (render-values.sh rewrites this block per MODE)"]
lines += [f"{indent}- $values/{f}" for f in files]
lines.append(f"{indent}# <<< MODE-VALUEFILES")
block = "\n".join(lines)
if dry == "1":
    print("  would set apps/10 valueFiles -> %s" % ", ".join(files))
    sys.exit(0)
text = text[:m.start()] + block + text[m.end():]
with open(path, "w") as fh:
    fh.write(text)
print("  set apps/10 valueFiles -> %s" % ", ".join(files))
PY
}

echo "==> rendering ($([[ $DRY_RUN -eq 1 ]] && echo dry-run || echo write))"
for s in "${SUBS[@]}"; do
  IFS='|' read -r token value file <<<"$s"
  apply_sub "$token" "$value" "$file"
done
rewrite_valuefiles "$MODE"

if [[ "$MODE" == "managed" ]]; then
  cat <<EOF

NOTE: still TODO by a human / publish-images.sh:
  - REPLACE-chat-model-id / REPLACE-embed-model-id  (pick from \`stackit ai-model-serving models\`)
  - REPLACE-*-DIGEST                                 (run: deploy/scripts/publish-images.sh --push)
Secrets (passwords/keys/token) go to Secrets Manager — see push-secrets.sh.
EOF
else
  cat <<EOF

Mode A (self-hosted): all backends are bundled in-cluster — no managed endpoints,
no registry digests, no Secrets Manager. Only REPLACE-DNS-NAME was filled.
Run \`make dns\` after ingress-nginx has its LoadBalancer IP to publish the records.
EOF
fi
