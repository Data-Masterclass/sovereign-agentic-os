#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# llm-providers/run.sh — provider-agnostic LLM setup, proven on REAL containers.
#
#   scripts/tests/llm-providers/run.sh
#   DOCKER_HOST=unix://$HOME/.colima/<profile>/docker.sock scripts/tests/llm-providers/run.sh
#
# 1. Renders THIS chart (STACKIT profile, plus two stub provider hosts on llmProviders.allowHosts and
#    `ollama` on llmProviders.noProxy) and takes from it (render.mjs): the gateway image, the
#    gateway's `litellm-egress-env` (HTTP(S)_PROXY / NO_PROXY), the egress proxy's tinyproxy.conf and
#    filter, the shared agent key's model list (with the access group), and os-ui's
#    LLM_EGRESS_ALLOWLIST / LLM_NO_PROXY / LLM_ACCESS_GROUP.
# 2. Two networks, like the cluster: `inner` (gateway, Postgres, egress proxy, an in-cluster Ollama
#    stub named `ollama`) and `outer` (egress proxy + the "internet": an OpenAI-compatible stub, an
#    Azure OpenAI stub, and a provider that is NOT allowlisted). The gateway cannot resolve or reach
#    an outer host except through the proxy, so the proxy's filter decides. Two outer stubs serve
#    HTTPS on 443 through the proxy's CONNECT tunnel: one with a certificate from a test CA the
#    gateway trusts (SSL_CERT_FILE), one self-signed (the untrusted-certificate twin).
# 3. Migrates the gateway's database with the gateway image, starts it, creates the shared agent key
#    with the rendered models and a second key WITHOUT the access group (negative twin).
# 4. Phase 1 of os-ui/tabs/admin/lib/llm-providers.e2e.test.ts (LLM_PROVIDERS_E2E_REQUIRED=1, a skip is
#    a failure): connect → test → register → chat for all three providers; the wrong-key, blocked-host
#    and no-access-group twins.
# 5. RESTARTS the gateway, then phase 2: every model still answers (durable in LiteLLM's database).
# 6. Reads the proxy log: the blocked host must appear as refused there, and the HTTPS provider as a
#    CONNECT tunnel; the untrusted-certificate provider received no HTTP request.
# Exit 0 only when every step passed.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
CHART=${CHART_DIR:-$REPO/charts/sovereign-agentic-os}
PROFILE=${PROFILE_VALUES:-$REPO/values.stackit-managed.yaml}
YAML_DIR=${JS_YAML_DIR:-$REPO/os-ui/node_modules/js-yaml}
# A path the Docker VM shares (Colima and Docker Desktop share $HOME, not $TMPDIR).
W=${LLM_PROVIDERS_WORKDIR:-$HOME/.cache/llm-providers-test}
MASTER=sk-test-master-not-a-secret
AGENT_KEY=sk-test-scoped-agent-key-0001
NOGROUP_KEY=sk-test-key-without-group-01
P=llmp
step() { printf '\n==================== %s\n' "$*"; }
down() { docker rm -f $P-gw $P-pg $P-proxy $P-openai $P-azure $P-ollama $P-blocked $P-tls $P-untrusted >/dev/null 2>&1; docker network rm $P-inner $P-outer >/dev/null 2>&1; }
die() { docker logs $P-gw > "$W/gw.log" 2>&1 || true; docker logs $P-proxy > "$W/proxy.log" 2>&1 || true; echo "LLM_PROVIDERS_TEST_FAILED — $*"; exit 1; }
[ -n "${KEEP:-}" ] || trap down EXIT
command -v docker >/dev/null && docker info >/dev/null 2>&1 || die "docker is not running"
rm -rf "$W"; mkdir -p "$W/stubs" "$W/render"; chmod 777 "$W/stubs"

step "render the chart and derive what the cluster runs"
helm template agentic-os "$CHART" -n agentic-os -f "$PROFILE" \
  --set 'llmProviders.allowHosts={openai-stub.example.test,azure-stub.example.test,tls-stub.example.test,untrusted-stub.example.test}' \
  --set 'llmProviders.localModels={ollama}' > "$W/render/rendered.yaml" 2>"$W/helm.err" || { cat "$W/helm.err"; die "helm template failed (helm dependency build first?)"; }
node "$HERE/render.mjs" "$W/render/rendered.yaml" "$W/render" "$YAML_DIR" > "$W/facts.txt" || die "render.mjs"
fact() { node -e 'const f=require(process.argv[1]);const v=f[process.argv[2]];console.log(Array.isArray(v)?JSON.stringify(v):v)' "$W/render/facts.json" "$1"; }
IMAGE=${LITELLM_IMAGE:-$(fact image)}
MODELS=$(fact agentKeyModels); GROUP=$(fact accessGroup); ALLOW=$(fact allowlist); LOCAL=$(fact localModels)
NOPROXY=$(sed -n 's/^NO_PROXY=//p' "$W/render/gw.env")
grep -q '^HTTPS_PROXY=http://egress-proxy:3128$' "$W/render/gw.env" || die "the rendered gateway env does not route through the egress proxy"
echo "gateway $IMAGE; access group $GROUP; agent key models $MODELS"
echo "NO_PROXY $NOPROXY"

step "test certificates (a CA the gateway trusts, and a self-signed one it does not)"
C="$W/certs"; mkdir -p "$C"
# Python 3.13 verifies strictly (VERIFY_X509_STRICT): the CA needs critical basicConstraints and
# keyCertSign, the leaf an authority key identifier.
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=llm-providers test CA" -keyout "$C/ca.key" -out "$C/ca.crt" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -addext "subjectKeyIdentifier=hash" >/dev/null 2>&1 || die "CA"
openssl req -newkey rsa:2048 -nodes -subj "/CN=tls-stub.example.test" -keyout "$C/tls.key" -out "$C/tls.csr" >/dev/null 2>&1 || die "csr"
printf 'subjectAltName=DNS:tls-stub.example.test\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n' > "$C/ext.cnf"
openssl x509 -req -in "$C/tls.csr" -CA "$C/ca.crt" -CAkey "$C/ca.key" -CAcreateserial -days 2 -extfile "$C/ext.cnf" -out "$C/tls.crt" >/dev/null 2>&1 || die "sign"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=untrusted-stub.example.test" -addext "subjectAltName=DNS:untrusted-stub.example.test" \
  -keyout "$C/untrusted.key" -out "$C/untrusted.crt" >/dev/null 2>&1 || die "self-signed"
chmod 644 "$C"/*

step "egress proxy image (images/base/egress-proxy, the chart's tinyproxy)"
docker build -q -t llmp-egress-proxy:test "$REPO/images/base/egress-proxy" >/dev/null || die "egress proxy image build"

step "networks, Postgres, proxy, provider stubs"
down
docker network create $P-inner >/dev/null && docker network create $P-outer >/dev/null
docker run -d --name $P-pg --network $P-inner -e POSTGRES_USER=l -e POSTGRES_PASSWORD=l -e POSTGRES_DB=litellm postgres:16-alpine >/dev/null
docker run -d --name $P-proxy --network $P-inner --network-alias egress-proxy \
  -v "$W/render/proxy/tinyproxy.conf:/etc/tinyproxy/tinyproxy.conf:ro" -v "$W/render/proxy/filter:/etc/tinyproxy/filter:ro" \
  llmp-egress-proxy:test >/dev/null
docker network connect $P-outer $P-proxy
stub() { # name kind network alias [tls-cert-name]
  local tls=(-e PORT=80)
  [ -n "${5:-}" ] && tls=(-e PORT=443 -e TLS_CERT=/certs/$5.crt -e TLS_KEY=/certs/$5.key)
  docker run -d --name $P-$1 --network "$3" --network-alias "$4" -e STUB_KIND="$2" -e STUB_NAME="$1" "${tls[@]}" -e DATA_DIR=/data \
    -v "$HERE:/h:ro" -v "$W/stubs:/data" -v "$C:/certs:ro" node:22-alpine node /h/stub.mjs >/dev/null
}
stub openai openai $P-outer openai-stub.example.test
stub azure azure $P-outer azure-stub.example.test
stub blocked openai $P-outer blocked-stub.example.test
stub ollama ollama $P-inner ollama
stub tls openai $P-outer tls-stub.example.test tls
stub untrusted openai $P-outer untrusted-stub.example.test untrusted
for i in $(seq 1 60); do docker exec $P-pg pg_isready -U l >/dev/null 2>&1 && break; sleep 1; done

cat > "$W/config.yaml" <<'EOF'
model_list:
  - model_name: sovereign-default
    litellm_params: { model: ollama_chat/llama3.2:1b, api_base: http://ollama }
general_settings:
  master_key: os.environ/PROXY_MASTER_KEY
  store_model_in_db: true
EOF
gw_up() {
  docker rm -f $P-gw >/dev/null 2>&1
  docker run -d --name $P-gw --network $P-inner -p 127.0.0.1:24400:4000 --env-file "$W/render/gw.env" \
    -e DATABASE_URL=postgresql://l:l@$P-pg:5432/litellm -e PROXY_MASTER_KEY=$MASTER -e LITELLM_SALT_KEY=sk-test-salt-not-a-secret \
    -e STORE_MODEL_IN_DB=true -e DISABLE_SCHEMA_UPDATE=true -e SSL_CERT_FILE=/certs/ca.crt -e SSL_VERIFY=/certs/ca.crt -v "$C/ca.crt:/certs/ca.crt:ro" -e NO_PROXY="$NOPROXY,$P-pg" -e no_proxy="$NOPROXY,$P-pg" \
    -v "$W/config.yaml:/etc/litellm/config.yaml:ro" "$IMAGE" --config /etc/litellm/config.yaml --port 4000 >/dev/null
  for i in $(seq 1 90); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:24400/health/readiness || true)" = 200 ] && return 0
    docker inspect -f '{{.State.Running}}' $P-gw 2>/dev/null | grep -q true || { docker logs --tail 40 $P-gw; return 1; }
    sleep 2
  done
  docker logs --tail 40 $P-gw; return 1
}

step "gateway: migrate its database with the gateway image, then start it"
docker run --rm --network $P-inner --entrypoint python -w /app -e DATABASE_URL=postgresql://l:l@$P-pg:5432/litellm \
  -e DISABLE_SCHEMA_UPDATE=false "$IMAGE" litellm/proxy/prisma_migration.py > "$W/migrate.log" 2>&1 || { tail -30 "$W/migrate.log"; die "migration failed"; }
gw_up || die "the gateway did not start"
docker exec $P-gw sh -c 'echo "gateway proxy env: HTTPS_PROXY=$HTTPS_PROXY"'
key() { curl -sS -o /dev/null -w "$2: HTTP %{http_code}\n" -H "Authorization: Bearer $MASTER" -H 'content-type: application/json' \
  http://127.0.0.1:24400/key/generate -d "{\"key\":\"$1\",\"key_alias\":\"$2\",\"models\":$3}"; }
key $AGENT_KEY sovereign-agents "$MODELS"
key $NOGROUP_KEY no-group '["sovereign-default"]'

# The OS check's resolver (the test process cannot resolve the Docker "internet"): public TEST-NET-3
# addresses for the outer hosts, a cluster-style address for the in-cluster Ollama.
DNS='{"openai-stub.example.test":["203.0.113.10"],"azure-stub.example.test":["203.0.113.11"],"tls-stub.example.test":["203.0.113.12"],"untrusted-stub.example.test":["203.0.113.13"],"blocked-stub.example.test":["203.0.113.14"],"ollama":["10.96.0.10"]}'
run_phase() { # $1 phase
  (cd "$REPO/os-ui" && LITELLM_URL=http://127.0.0.1:24400 LITELLM_MASTER_KEY=$MASTER LLM_E2E_AGENT_KEY=$AGENT_KEY \
    LLM_E2E_NO_GROUP_KEY=$NOGROUP_KEY LLM_E2E_STUB_DIR="$W/stubs" LLM_E2E_PHASE=$1 LLM_PROVIDERS_E2E_REQUIRED=1 \
    LLM_EGRESS_ALLOWLIST="$ALLOW" LLM_NO_PROXY="$NOPROXY" LLM_LOCAL_MODELS="$LOCAL" LLM_ACCESS_GROUP="$GROUP" LLM_E2E_DNS="$DNS" \
    node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test --test-reporter=spec --test-concurrency=1 tabs/admin/lib/llm-providers.e2e.test.ts) > "$W/e2e-$1.log" 2>&1
}

step "phase 1: connect, test, register, call — and the negative twins"
run_phase 1; rc=$?
grep -E '✔|✖|ℹ (pass|fail|skipped)|AssertionError|actual:|expected:' "$W/e2e-1.log" | head -40
[ $rc = 0 ] || die "phase 1 failed (log: $W/e2e-1.log)"
grep -q 'ℹ skipped 0' "$W/e2e-1.log" || die "phase 1 skipped tests"

step "restart the gateway (state must come back from LiteLLM's database)"
gw_up || die "the gateway did not restart"
run_phase 2; rc=$?
grep -E '✔|✖|ℹ (pass|fail|skipped)|AssertionError' "$W/e2e-2.log" | head -20
[ $rc = 0 ] || die "phase 2 failed after the restart (log: $W/e2e-2.log)"

step "the egress proxy refused the non-allowlisted host"
docker logs $P-proxy > "$W/proxy.log" 2>&1
grep -i 'blocked-stub.example.test' "$W/proxy.log" | grep -i -E 'filter|denied|refus' | head -3
grep -i 'blocked-stub.example.test' "$W/proxy.log" | grep -q -i -E 'filter|denied|refus' || die "the proxy log shows no refusal of the blocked host"
[ ! -s "$W/stubs/blocked.jsonl" ] || die "the blocked provider received a request"

step "the HTTPS provider was reached through the proxy's CONNECT tunnel"
grep -i 'CONNECT' "$W/proxy.log" | grep -i 'tls-stub.example.test:443' | head -2
grep -i 'CONNECT' "$W/proxy.log" | grep -q -i 'tls-stub.example.test:443' || die "no CONNECT to the HTTPS provider in the proxy log"
[ ! -s "$W/stubs/untrusted.jsonl" ] || die "the untrusted-certificate provider received an HTTP request"

echo; echo "LLM_PROVIDERS_TEST_PASSED"
