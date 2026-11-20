#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# trino-seed-writers.kind.sh — a REAL Trino on kind evaluates the rules.json the OS writes on a
# fresh install: the chart's seed Jobs may create their one schema; with no seed writers they may not.
# =============================================================================
#   bash scripts/tests/trino-seed-writers.kind.sh        (needs docker, kind, kubectl, helm, node)
#
# The bug (first dev install, 2026-11-20): os-ui reconciles Trino's file-based rules at boot, before
# the post-install hooks dbt-build (dbt.trino.user) and northpeak-marts-init (marts.trino.user) run;
# both run CREATE SCHEMA IF NOT EXISTS iceberg.sales and were denied. The fix: the chart hands the
# OS its seed writers (TRINO_SEED_WRITERS) and the generator makes each the owner of exactly its one
# schema.
#
# What runs: the chart's own render gives TRINO_SEED_WRITERS; os-ui's own buildTrinoRules turns a
# fresh-install directory (the Northpeak cast) plus those writers into rules.json; Trino 476 (the
# chart's pinned version) loads it with file-based access control and a memory catalog, and the
# hooks' statements are run AS the hook users:
#   1. dbt-sales and northpeak-marts: CREATE SCHEMA IF NOT EXISTS sales, CTAS in it      -> allowed
#   2. the same users: CREATE SCHEMA in another domain, in a personal lane, an unknown one -> denied
#   3. once `sales` is a REAL domain (the directory grows one), the writers lose it: only the
#      domain's principals own it, the hook users are denied                               -> denied
#   4. NEGATIVE TWIN: the same directory WITHOUT seed writers (today's main) -> the hook CREATE is denied
# Own kind cluster and kubeconfig, deleted at the end. Not the full chart: OPA (which already allows
# these users) is not in the loop; this proves the file rule, which was the one that denied.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
# shellcheck source=scripts/tests/assert.sh
. scripts/tests/assert.sh
for b in docker kind kubectl helm node; do command -v "$b" >/dev/null || { echo "$b not on PATH"; exit 2; }; done
ls charts/sovereign-agentic-os/charts/*.tgz >/dev/null 2>&1 || { echo "no subchart .tgz (helm dependency build charts/sovereign-agentic-os)"; exit 2; }
[ -d os-ui/node_modules ] || { echo "os-ui dependencies missing (npm --prefix os-ui ci)"; exit 2; }
NAME=${SEED_KIND_NAME:-trino-seed}
IMAGE=trinodb/trino:476
TMP=$(mktemp -d)
export KUBECONFIG=$TMP/kubeconfig
cleanup() { [ -n "${SEED_KEEP:-}" ] || kind delete cluster --name "$NAME" --kubeconfig "$KUBECONFIG" >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT
K() { kubectl --context "kind-$NAME" -n seed "$@"; }

# ---- the chart's seed writers, from its own render -------------------------------------------
writers=$(helm template agentic-os charts/sovereign-agentic-os -n agentic-os --skip-schema-validation 2>/dev/null \
  | grep -A1 'name: TRINO_SEED_WRITERS' | sed -n 's/.*value: "\(.*\)"/\1/p' | head -1)
check "the chart renders TRINO_SEED_WRITERS for its seed Jobs" "dbt-sales:sales" "$writers"
check "both seed Jobs are listed" "northpeak-marts:sales" "$writers"

# ---- rules.json from the OS's own generator (with, and without, the writers) -----------------
gen() { # gen <writers or empty> <out> [with-sales-domain]
  (cd os-ui && SEED_WRITERS="$1" SALES_DOMAIN="${3:-}" node --import ./scripts/test-setup.mjs --input-type=module -e "
    const { buildTrinoRules, renderTrinoRules } = await import('./core/infra/trino-rules.ts');
    const seedWriters = (process.env.SEED_WRITERS || '').split(',').filter(Boolean).map((p) => { const [user, schema] = p.split(':'); return { user, schema }; });
    const cast = ['nova-admin', 'riley-sales', 'sasha-sales', 'kai-mktg'];
    process.stdout.write(renderTrinoRules(buildTrinoRules({
      serviceUsers: ['dbt-runner'], principalPattern: '[A-Za-z0-9][A-Za-z0-9._-]{0,63}',
      domains: [...(process.env.SALES_DOMAIN ? [{ name: 'sales', schema: 'sales', principals: ['nova-admin', 'riley-sales', 'sasha-sales'] }] : []),
                { name: 'marketing', schema: 'marketing', principals: ['kai-mktg', 'nova-admin'] }],
      personalLanes: cast.map((uid) => ({ uid, schema: 'personal_' + uid.replace(/-/g, '_') })),
      seedWriters,
    })));") > "$2" 2>/dev/null
}
gen "$writers" "$TMP/rules-fixed.json" || { echo "rules generation failed"; exit 2; }
gen "" "$TMP/rules-main.json" || { echo "rules generation failed"; exit 2; }
gen "$writers" "$TMP/rules-domain.json" with-sales-domain || { echo "rules generation failed"; exit 2; }

# ---- a real Trino on kind --------------------------------------------------------------------
kind create cluster --name "$NAME" --kubeconfig "$KUBECONFIG" --wait 120s >/dev/null 2>&1 || { echo "kind create failed"; exit 2; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull -q "$IMAGE" >/dev/null
# Load ONE platform: `kind load docker-image` of a multi-arch image fails on a containerd image
# store ("content digest … not found"); a single-platform archive loads.
arch=$(docker version --format '{{.Server.Arch}}' 2>/dev/null || echo amd64)
docker save --platform "linux/$arch" "$IMAGE" -o "$TMP/image.tar" >/dev/null 2>&1 \
  && kind load image-archive "$TMP/image.tar" --name "$NAME" >/dev/null 2>&1 \
  || echo "note: kind load failed; the node pulls the image itself"
rm -f "$TMP/image.tar"
kubectl --context "kind-$NAME" create namespace seed >/dev/null
K create configmap trino-rules --from-file=rules.json="$TMP/rules-fixed.json" >/dev/null
K apply -f - >/dev/null <<YAML
apiVersion: v1
kind: ConfigMap
metadata: { name: trino-etc }
data:
  access-control.properties: |
    access-control.name=file
    security.config-file=/etc/trino/rules/rules.json
    security.refresh-period=2s
  memory.properties: |
    connector.name=memory
---
apiVersion: v1
kind: Pod
metadata: { name: trino, labels: { app: trino } }
spec:
  containers:
    - name: trino
      image: $IMAGE
      imagePullPolicy: IfNotPresent
      resources: { requests: { cpu: 250m, memory: 1Gi }, limits: { memory: 2Gi } }
      volumeMounts:
        - { name: etc, mountPath: /etc/trino/access-control.properties, subPath: access-control.properties }
        - { name: etc, mountPath: /etc/trino/catalog/memory.properties, subPath: memory.properties }
        - { name: rules, mountPath: /etc/trino/rules }
  volumes:
    - { name: etc, configMap: { name: trino-etc } }
    - { name: rules, configMap: { name: trino-rules } }
YAML
K wait --for=condition=Ready pod/trino --timeout=900s >/dev/null || { K describe pod trino | tail -20; exit 2; }
sql() { # sql <user> <statement> — prints the result or the error
  K exec trino -- trino --user "$1" --execute "$2" 2>&1 | grep -v -iE 'jline|terminal' || true
}
for _ in $(seq 1 60); do sql probe "SELECT 1" | grep -q '"1"' && break; sleep 3; done

echo "== 1. the seed Jobs create and fill their schema"
out=$(sql dbt-sales "CREATE SCHEMA IF NOT EXISTS memory.sales"); check "dbt-sales: CREATE SCHEMA IF NOT EXISTS sales is allowed" "CREATE SCHEMA" "$out"
out=$(sql northpeak-marts "CREATE SCHEMA IF NOT EXISTS memory.sales"); check "northpeak-marts: CREATE SCHEMA IF NOT EXISTS sales is allowed" "CREATE SCHEMA" "$out"
out=$(sql northpeak-marts "CREATE TABLE memory.sales.gold_northpeak_commerce AS SELECT 1 AS x"); check "northpeak-marts: CTAS in sales is allowed" "CREATE TABLE: 1 row" "$out"
out=$(sql dbt-sales "CREATE TABLE memory.sales.stg_orders AS SELECT 1 AS x"); check "dbt-sales: CTAS in sales is allowed" "CREATE TABLE: 1 row" "$out"

echo "== 2. and nothing else"
out=$(sql dbt-sales "CREATE SCHEMA memory.marketing"); check "dbt-sales: another domain's schema is denied" "Access Denied" "$out"
out=$(sql northpeak-marts "CREATE SCHEMA memory.personal_nova_admin"); check "northpeak-marts: a personal lane is denied" "Access Denied" "$out"
out=$(sql dbt-sales "CREATE SCHEMA memory.anything_else"); check "dbt-sales: an unknown schema is denied" "Access Denied" "$out"

echo "== 3. once sales is a REAL domain, the seed writers lose it; only its principals own it"
K create configmap trino-rules --from-file=rules.json="$TMP/rules-domain.json" --dry-run=client -o yaml | K replace -f - >/dev/null
denied=''
for _ in $(seq 1 40); do
  out=$(sql northpeak-marts "CREATE SCHEMA IF NOT EXISTS memory.sales")
  case $out in *"Access Denied"*) denied=1; break ;; esac
  sleep 3
done
holds "NEGATIVE TWIN: northpeak-marts may not own the sales DOMAIN's schema" [ -n "$denied" ]
out=$(sql dbt-sales "CREATE TABLE memory.sales.after_domain AS SELECT 1 AS x"); check "dbt-sales may not write tables in the sales domain" "Access Denied" "$out"
out=$(sql sales "CREATE TABLE memory.sales.by_domain AS SELECT 1 AS x"); check "the domain principal sales still writes there" "CREATE TABLE: 1 row" "$out"
out=$(sql kai-mktg "CREATE TABLE memory.sales.outsider AS SELECT 1 AS x"); check "an outsider still cannot write in sales" "Access Denied" "$out"

echo "== 4. NEGATIVE TWIN: the same fresh-install directory without seed writers (main before this fix)"
K create configmap trino-rules --from-file=rules.json="$TMP/rules-main.json" --dry-run=client -o yaml | K replace -f - >/dev/null
denied=''
for _ in $(seq 1 40); do
  out=$(sql dbt-sales "CREATE SCHEMA IF NOT EXISTS memory.sales")
  case $out in *"Access Denied"*) denied=1; break ;; esac
  sleep 3   # the kubelet syncs the ConfigMap volume, then Trino's 2 s refresh picks it up
done
holds "without seed writers the hook's CREATE SCHEMA IF NOT EXISTS is denied (the bug)" [ -n "$denied" ]
out=$(sql northpeak-marts "CREATE SCHEMA IF NOT EXISTS memory.sales"); check "for northpeak-marts too" "Access Denied" "$out"

finish trino-seed-writers.kind || exit 1
echo "TRINO_SEED_WRITERS_KIND_OK"
