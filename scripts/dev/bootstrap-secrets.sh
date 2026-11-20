#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# bootstrap-secrets.sh — the dev environment's OWN random secrets, written ONLY to the dev
# cluster and to a private overlay outside git.
# =============================================================================
#   scripts/dev/bootstrap-secrets.sh [--rotate]
#
# What it does, in order (idempotent; a second run changes nothing unless --rotate):
#   1. Proves the target is the dev cluster BEFORE the marker exists: the dev state says
#      environment=dev, the context is not the production context, and its API server is the one
#      in the dev state (scripts/dev/lib.sh require_dev_cluster).
#   2. Writes the marker ConfigMap kube-public/sovereign-os-environment (environment=dev) that
#      scripts/lib/env-guard.sh requires for every later dev deploy.
#   3. Generates, ONCE, a random value for EVERY credential literal of the chart's values.yaml
#      (gateway master/UI/agent keys, Langfuse keys + init user + core secrets, Postgres roles,
#      ClickHouse, Valkey, MinIO, Polaris, the agent-runtime token), plus the synthetic Northpeak
#      cast with random passwords (seed/ecommerce/lib/narrative.mjs), into
#        $DEV_PRIVATE_DIR/values.dev.private.yaml   (mode 600; DEV_PRIVATE_DIR=~/.sovereign-os-secrets/dev)
#        $DEV_PRIVATE_DIR/northpeak-cast.secret.json (the seed's SEED_CREDENTIALS)
#      --rotate generates new ones; only after scripts/dev/reset.sh (the databases keep the old ones).
#   4. Writes into the dev cluster (namespace agentic-os):
#        Secret sovereign-os-dev-values      key values.yaml = the private overlay (CI reads it)
#        Secret northpeak-seed-credentials   key SEED_CREDENTIALS (scripts/dev/seed.sh)
#        Secret dev-backup-s3                the dev bucket + its dev-only key (tofu outputs)
#        Secret registry-pull-secret         from $DEV_PRIVATE_DIR/ghcr-read-token (read:packages)
#
# Inputs the OWNER provides (files in $DEV_PRIVATE_DIR, mode 600; see docs/ops/dev-environment.md):
#   stackit-model-key   the dev project's own STACKIT AI Model Serving token (low budget). Absent
#                       => the overlay's key is empty; use DEV_MODEL=stub for deploys.
#   ghcr-read-token     a GitHub token with read:packages only; ghcr-read-user holds its login.
#
# Prints names and counts, never a value. Writes go through stdin (`kubectl apply -f -`), so no
# value is on a command line.
. "$(dirname "$0")/lib.sh"
ROTATE=''
[ "${1:-}" != --rotate ] || ROTATE=1

say "1. the target is the dev cluster ($CTX)"
require_dev_cluster
echo "   ok: dev state, context $CTX, API server matches the dev state"

say "2. environment marker kube-public/sovereign-os-environment = dev"
k apply -f - >/dev/null <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: sovereign-os-environment
  namespace: kube-public
  labels: { app.kubernetes.io/part-of: sovereign-agentic-os }
data:
  environment: dev
YAML
require_marked_dev
echo "   ok"

say "3. private overlay in $DEV_PRIVATE_DIR"
private_dir
OVERLAY=$DEV_PRIVATE_DIR/values.dev.private.yaml
CAST=$DEV_PRIVATE_DIR/northpeak-cast.secret.json
MODEL_KEY_FILE=$DEV_PRIVATE_DIR/stackit-model-key
if [ -s "$OVERLAY" ] && [ -s "$CAST" ] && [ -z "$ROTATE" ]; then
  echo "   kept the existing overlay (pass --rotate after a reset for new values)"
else
  node --input-type=module -e '
    import { CAST } from "'"$REPO_ROOT"'/seed/ecommerce/lib/narrative.mjs";
    import { randomBytes } from "node:crypto";
    import { writeFileSync } from "node:fs";
    const pw = () => randomBytes(15).toString("base64url") + "A9!";
    const creds = {}, users = [];
    for (const c of CAST) { const p = pw(); creds[c.id] = p; users.push({ id: c.id, name: c.name, email: c.email, password: p, domains: c.domains, role: c.role }); }
    writeFileSync(process.argv[1], JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
    writeFileSync(process.argv[2], JSON.stringify(users), { mode: 0o600 });
  ' "$CAST" "$DEV_PRIVATE_DIR/os-users.seed.json"
  ( umask 077
    python3 - "$REPO_ROOT/charts/sovereign-agentic-os/values.yaml" "$DEV_PRIVATE_DIR/os-users.seed.json" "$MODEL_KEY_FILE" > "$OVERLAY.tmp" <<'PY'
import json, os, secrets, sys, yaml
chart = yaml.safe_load(open(sys.argv[1]))
users = open(sys.argv[2]).read().strip()
key = open(sys.argv[3]).read().strip() if os.path.exists(sys.argv[3]) else ""
r = lambda n=32: secrets.token_urlsafe(n)
pg = chart["postgres"]
extra = []
for d in pg["extraDatabases"]:
    d = dict(d); d["localPassword"] = r(24); extra.append(d)
gov = {k: {"localPassword": r(24)} for k in ("owner", "runtime", "queue")}
overlay = {
    "litellmMasterKey": "sk-" + r(),
    "litellmUI": {"username": "admin", "password": r(24)},
    "litellmAgentKey": {"local": {"value": "sk-" + r()}},
    "langfuseInit": {
        "publicKey": "pk-lf-" + secrets.token_hex(16), "secretKey": "sk-lf-" + secrets.token_hex(16),
        "userEmail": "langfuse-admin@northpeak.demo", "userName": "Dev Admin", "userPassword": r(24),
        "salt": r(), "nextauthSecret": r(), "encryptionKey": secrets.token_hex(32),
    },
    "agentRuntime": {"token": r()},
    "clickhouse": {"local": {"password": r(24)}},
    "valkey": {"local": {"password": r(24)}},
    "objectStorage": {"local": {"accessKey": "dev" + secrets.token_hex(8), "secretKey": r(30)}},
    "postgres": {"local": {"password": r(24)}, "extraDatabases": extra, "governance": gov},
    "polaris": {"local": {"rootClientId": "root", "rootClientSecret": r(24)}},
    "stackitPremium": {"local": {"apiKey": key}},
    # The synthetic Northpeak cast — demo identities, NO real user list.
    "osUI": {"usersSeed": users},
}
print("# GENERATED by scripts/dev/bootstrap-secrets.sh — dev only, never commit, never print.")
yaml.safe_dump(overlay, sys.stdout, sort_keys=False, width=1000)
PY
  ) && mv "$OVERLAY.tmp" "$OVERLAY"
  rm -f "$DEV_PRIVATE_DIR/os-users.seed.json"
  chmod 600 "$OVERLAY" "$CAST"
  echo "   generated $(grep -c ':' "$OVERLAY") overlay lines and $(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$CAST") demo users"
fi
[ -s "$MODEL_KEY_FILE" ] && echo "   dev model key: present" || echo "   dev model key: ABSENT — deploy with DEV_MODEL=stub, or add $MODEL_KEY_FILE and re-run with --rotate after a reset"

say "4. secrets in the dev cluster (namespace $NS)"
k get ns "$NS" >/dev/null 2>&1 || k create ns "$NS" >/dev/null
apply_secret() { # apply_secret <name> <kubectl create secret args...>  (values via files only)
  local name=$1; shift
  k -n "$NS" create secret "$@" "$name" --dry-run=client -o yaml | k -n "$NS" apply -f - >/dev/null
  echo "   secret/$name"
}
apply_secret sovereign-os-dev-values generic --from-file=values.yaml="$OVERLAY"
apply_secret northpeak-seed-credentials generic --from-file=SEED_CREDENTIALS="$CAST"
S3=$(mktemp -d); trap 'rm -rf "$S3"' EXIT
( umask 077
  tf_out object_storage_bucket > "$S3/BUCKET"
  tf_out object_storage_endpoint > "$S3/ENDPOINT"
  tf_out object_storage_access_key > "$S3/AWS_ACCESS_KEY_ID"
  tf_out object_storage_secret_key > "$S3/AWS_SECRET_ACCESS_KEY" )
apply_secret dev-backup-s3 generic --from-file="$S3/BUCKET" --from-file="$S3/ENDPOINT" \
  --from-file="$S3/AWS_ACCESS_KEY_ID" --from-file="$S3/AWS_SECRET_ACCESS_KEY"
if [ -s "$DEV_PRIVATE_DIR/ghcr-read-token" ] && [ -s "$DEV_PRIVATE_DIR/ghcr-read-user" ]; then
  python3 - "$DEV_PRIVATE_DIR/ghcr-read-user" "$DEV_PRIVATE_DIR/ghcr-read-token" > "$S3/.dockerconfigjson" <<'PY'
import base64, json, sys
u, t = (open(p).read().strip() for p in sys.argv[1:3])
print(json.dumps({"auths": {"ghcr.io": {"auth": base64.b64encode(f"{u}:{t}".encode()).decode()}}}))
PY
  apply_secret registry-pull-secret generic --type=kubernetes.io/dockerconfigjson --from-file=.dockerconfigjson="$S3/.dockerconfigjson"
else
  echo "   registry-pull-secret: SKIPPED — no $DEV_PRIVATE_DIR/ghcr-read-token (+ ghcr-read-user); private images will not pull"
fi
echo "BOOTSTRAP_SECRETS_OK context=$CTX"
