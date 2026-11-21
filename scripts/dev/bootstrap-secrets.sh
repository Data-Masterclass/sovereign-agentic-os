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
#   4. The STACKIT model key goes ONLY into namespace dev-model-key (Secret stackit-model-key),
#      read by a small reverse proxy (nginx, pinned) that adds it to each request LiteLLM sends.
#      The CI account has no rights there (ci-kubeconfig.sh checks it with `kubectl auth can-i`),
#      so neither CI nor anything it deploys can read the key. Two NetworkPolicies: LiteLLM may
#      reach the proxy; nothing else may.
#   5. Writes into the dev cluster (namespace agentic-os):
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

say "2b. namespaces with their Pod Security labels (agentic-os: baseline enforced)"
k apply -f "$REPO_ROOT/scripts/dev/manifests/namespaces.yaml" >/dev/null
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
    python3 - "$REPO_ROOT/charts/sovereign-agentic-os/values.yaml" "$DEV_PRIVATE_DIR/os-users.seed.json" > "$OVERLAY.tmp" <<'PY'
import json, secrets, sys, yaml
chart = yaml.safe_load(open(sys.argv[1]))
users = open(sys.argv[2]).read().strip()
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
say "4. the model key, in namespace dev-model-key only (CI has no rights there)"
MK=dev-model-key
k get ns "$MK" >/dev/null 2>&1 || k create ns "$MK" >/dev/null
if [ -s "$MODEL_KEY_FILE" ]; then
  k -n "$MK" create secret generic stackit-model-key --from-file=STACKIT_API_KEY="$MODEL_KEY_FILE" \
    --dry-run=client -o yaml | k -n "$MK" apply -f - >/dev/null
  echo "   secret/stackit-model-key (dev-model-key)"
  k apply -f - >/dev/null <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata: { name: model-key-proxy, namespace: dev-model-key }
data:
  # nginx's own envsubst (NGINX_ENVSUBST_FILTER) writes conf.d/default.conf at start.
  default.conf.template: |
    server {
      listen 8080;
      location = /healthz { return 200 'ok'; }
      location / {
        proxy_pass https://api.openai-compat.model-serving.eu01.onstackit.cloud;
        proxy_ssl_server_name on;
        # STACKIT's endpoint refuses HTTP/1.0 (nginx's proxy default) by closing the connection.
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host api.openai-compat.model-serving.eu01.onstackit.cloud;
        proxy_set_header Authorization "Bearer ${STACKIT_API_KEY}";
        proxy_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        client_max_body_size 50m;
      }
    }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: model-key-proxy, namespace: dev-model-key, labels: { app: model-key-proxy } }
spec:
  replicas: 1
  selector: { matchLabels: { app: model-key-proxy } }
  template:
    metadata: { labels: { app: model-key-proxy } }
    spec:
      automountServiceAccountToken: false
      securityContext: { runAsNonRoot: true, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: nginx
          image: nginxinc/nginx-unprivileged:1.27.3-alpine@sha256:9e7238f579a54582263a960d1b0094b4a3ecce641342eda3f8e2ff82b1703d2b
          ports: [{ containerPort: 8080 }]
          env:
            - { name: NGINX_ENVSUBST_FILTER, value: "^STACKIT_API_KEY$" }
            - name: STACKIT_API_KEY
              valueFrom: { secretKeyRef: { name: stackit-model-key, key: STACKIT_API_KEY } }
          volumeMounts: [{ name: tpl, mountPath: /etc/nginx/templates }]
          readinessProbe: { httpGet: { path: /healthz, port: 8080 } }
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } }
          resources:
            requests: { cpu: 10m, memory: 32Mi }
            limits: { memory: 64Mi }
      volumes: [{ name: tpl, configMap: { name: model-key-proxy } }]
---
apiVersion: v1
kind: Service
metadata: { name: model-key-proxy, namespace: dev-model-key }
spec:
  selector: { app: model-key-proxy }
  ports: [{ port: 8080, targetPort: 8080 }]
---
# Only the gateway (LiteLLM in agentic-os) may call the proxy.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: model-key-proxy-litellm-only, namespace: dev-model-key }
spec:
  podSelector: { matchLabels: { app: model-key-proxy } }
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: agentic-os } }
          podSelector: { matchLabels: { app.kubernetes.io/name: litellm } }
      ports: [{ port: 8080 }]
YAML
  echo "   model-key-proxy (dev-model-key): deployment, service, ingress policy"
else
  echo "   dev model key: ABSENT — no model-key-proxy; deploy with DEV_MODEL=stub, or add $MODEL_KEY_FILE and re-run"
fi

say "5. secrets in the dev cluster (namespace $NS)"
k get ns "$NS" >/dev/null 2>&1 || k create ns "$NS" >/dev/null
apply_secret() { # apply_secret <name> <kubectl create secret args...>  (values via files only)
  local name=$1; shift
  k -n "$NS" create secret "$@" "$name" --dry-run=client -o yaml | k -n "$NS" apply -f - >/dev/null
  echo "   secret/$name"
}
S3=$(mktemp -d); trap 'rm -rf "$S3"' EXIT
apply_secret sovereign-os-dev-values generic --from-file=values.yaml="$OVERLAY"
# Dagster reads its database password from `dagster-postgresql` (key postgresql-password,
# dagster.global.postgresqlSecretName), which the chart does not render on a fresh install. It is
# the SAME password as the dagster role (postgres.extraDatabases[dagster].localPassword above).
python3 - "$OVERLAY" > "$S3/postgresql-password" <<'PY'
import sys, yaml
o = yaml.safe_load(open(sys.argv[1]))
print(next(d["localPassword"] for d in o["postgres"]["extraDatabases"] if d["name"] == "dagster"), end="")
PY
apply_secret dagster-postgresql generic --from-file=postgresql-password="$S3/postgresql-password"
apply_secret northpeak-seed-credentials generic --from-file=SEED_CREDENTIALS="$CAST"
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
# The chart's default-deny egress lets LiteLLM reach only its own namespace; this one rule lets it
# reach the model-key proxy. Not a chart object (helm never prunes it); reset.sh re-runs bootstrap.
k apply -f - >/dev/null <<'YAML'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: litellm-egress-model-key-proxy, namespace: agentic-os }
spec:
  podSelector: { matchLabels: { app.kubernetes.io/name: litellm } }
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: dev-model-key } }
          podSelector: { matchLabels: { app: model-key-proxy } }
      ports: [{ port: 8080 }]
YAML
echo "   networkpolicy/litellm-egress-model-key-proxy"
echo "BOOTSTRAP_SECRETS_OK context=$CTX"
