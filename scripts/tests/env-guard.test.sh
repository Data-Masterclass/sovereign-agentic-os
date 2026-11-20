#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# env-guard.test.sh — dev can never deploy to production (scripts/lib/env-guard.sh), and
# deploy.sh / smoke-test.sh / rollback.sh refuse BEFORE they touch a cluster.
# =============================================================================
#   bash scripts/tests/env-guard.test.sh
#
# kubectl is a stub that answers from files: the kubeconfig (context -> API server) and the
# kube-public/sovereign-os-environment marker per context. No cluster, no network.
# The negative twins are the point: each refusal case has a matching accepted case that differs
# in exactly the one fact the guard must see.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
# shellcheck source=scripts/tests/assert.sh
. scripts/tests/assert.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
BIN=$TMP/bin; mkdir -p "$BIN"
export FAKE_DIR=$TMP/fake FAKE_LOG=$TMP/calls.log
mkdir -p "$FAKE_DIR"

cat > "$BIN/kubectl" <<'STUB'
#!/usr/bin/env bash
echo "kubectl $*" >> "$FAKE_LOG"
all="$*"
if [ "$1" = config ] && [ "$2" = view ]; then
  ctx=$(printf '%s' "$all" | sed -n 's/.*contexts\[?(@.name=="\([^"]*\)")\].*/\1/p')
  cl=$(printf '%s' "$all" | sed -n 's/.*clusters\[?(@.name=="\([^"]*\)")\].*/\1/p')
  if [ -n "$ctx" ]; then [ -f "$FAKE_DIR/server-$ctx" ] && printf 'cl-%s' "$ctx"; exit 0; fi
  if [ -n "$cl" ]; then cat "$FAKE_DIR/server-${cl#cl-}" 2>/dev/null; exit 0; fi
  exit 0
fi
ctx=''; prev=''
for a in "$@"; do [ "$prev" = --context ] && ctx=$a; prev=$a; done
case $all in
  *"get nodes"*) cat "$FAKE_DIR/flavour-$ctx" 2>/dev/null ;;
  *"get configmap sovereign-os-environment"*)
    [ -f "$FAKE_DIR/marker-$ctx" ] || { echo 'Error from server (NotFound)' >&2; exit 1; }
    cat "$FAKE_DIR/marker-$ctx" ;;
esac
STUB
cat > "$BIN/helm" <<'STUB'
#!/usr/bin/env bash
echo "helm $*" >> "$FAKE_LOG"
case "$*" in *history*) echo '[]' ;; esac
STUB
cat > "$BIN/probe" <<'STUB'
#!/usr/bin/env bash
echo sha256:3333333333333333333333333333333333333333333333333333333333333333
STUB
chmod +x "$BIN"/*

reset() { rm -f "$FAKE_DIR"/*; : > "$FAKE_LOG"; }
# kube <context> <server> [marker] — put a context in the fake kubeconfig, optionally marked.
kube() { printf '%s' "$2" > "$FAKE_DIR/server-$1"; [ -z "${3:-}" ] || printf '%s' "$3" > "$FAKE_DIR/marker-$1"; }
guard() { out=$(PATH="$BIN:$PATH" bash scripts/lib/env-guard.sh "$@" 2>/dev/null); rc=$?; }
PROD=https://api.prod.example.invalid DEV=https://api.dev.example.invalid

echo "== defaults: the env picks the context"
guard --env prod --print-default-context; check "prod -> dmagenticos" "dmagenticos" "$out"
guard --env dev --print-default-context;  check "dev -> dmagosdev" "dmagosdev" "$out"
guard --env staging --context x; rc_is "an unknown env is refused" 1
guard --env dev; rc_is "no context is refused (never the current-context)" 1

echo "== dev"
reset; kube dmagenticos "$PROD"; kube dmagosdev "$DEV" dev
guard --env dev --context dmagosdev
rc_is "dev with the dev context, marked dev: accepted" 0
check "it says so" "ENV_GUARD_OK env=dev context=dmagosdev" "$out"

guard --env dev --context dmagenticos
rc_is "NEGATIVE TWIN: dev with the production context is refused" 1
check "with the reason" "dev can never deploy to production" "$out"

reset; kube dmagenticos "$PROD"; kube sneaky "$PROD" dev
guard --env dev --context sneaky
rc_is "NEGATIVE TWIN: a renamed context on the production API server is refused" 1
check "with the reason" "points at the production API server" "$out"

reset; kube dmagenticos "$PROD"; kube dmagosdev "$DEV"
guard --env dev --context dmagosdev
rc_is "NEGATIVE TWIN: a 'dev' cluster without the marker is refused" 1
check "with the reason" "no kube-public/sovereign-os-environment environment=dev marker" "$out"

reset; kube dmagosdev "$DEV" prod
guard --env dev --context dmagosdev
rc_is "NEGATIVE TWIN: a cluster marked prod is not dev" 1

echo "== prod"
reset; kube dmagenticos "$PROD"; kube dmagosdev "$DEV" dev
guard --env prod --context dmagenticos
rc_is "prod with the prod context (no marker yet): accepted" 0
guard --env prod --context dmagosdev
rc_is "NEGATIVE TWIN: prod with the dev context is refused" 1
reset; kube dmagosdev "$DEV" dev; kube other "$DEV"
guard --env prod --context other
rc_is "NEGATIVE TWIN: prod on the dev API server is refused" 1
reset; kube dmagenticos "$PROD" dev
guard --env prod --context dmagenticos
rc_is "NEGATIVE TWIN: prod on a cluster marked dev is refused" 1
reset; kube dmagenticos "$PROD" prod
guard --env prod --context dmagenticos
rc_is "prod on a cluster marked prod: accepted" 0

echo "== deploy.sh refuses before it touches the cluster"
deploy() {
  : > "$FAKE_LOG"
  out=$(PATH="$BIN:$PATH" DEPLOY_REGISTRY_PROBE="$BIN/probe" WORK=$(mktemp -d "$TMP/w.XXXX") "$@" 2>&1); rc=$?
  log=$(cat "$FAKE_LOG")
}
reset; kube dmagenticos "$PROD"; kube dmagosdev "$DEV" dev
deploy env DEV_KUBE_CONTEXT=dmagenticos bash scripts/deploy.sh --env dev --from-registry main-abc
rc_is "NEGATIVE TWIN: deploy.sh --env dev with the production context exits 1" 1
check "it is refused by the guard" "DEPLOY_REFUSED" "$out"
absent "no helm call at all" "helm " "$log"
absent "no kubectl call against the production cluster" "--context dmagenticos -n" "$log"

deploy env KUBE_CONTEXT=dmagosdev bash scripts/deploy.sh --from-registry 9.9.9
rc_is "NEGATIVE TWIN: a prod deploy (the default) aimed at the dev context exits 1" 1
absent "no helm call" "helm " "$log"

deploy env DEV_PRIVATE_VALUES=/nonexistent bash scripts/deploy.sh --env dev --from-registry main-abc
check "the matching dev deploy passes the guard" "ENV_GUARD_OK env=dev context=dmagosdev" "$out"
check "and goes on to read its private values" "DEV_PRIVATE_VALUES_MISSING" "$out"

echo "== deploy.sh --env dev: DEV_NODE must match the real node flavour"
printf 'osUI: {}\n' > "$TMP/private.yaml"
printf 'm2i.4' > "$FAKE_DIR/flavour-dmagosdev"
deploy env DEV_PRIVATE_VALUES="$TMP/private.yaml" bash scripts/deploy.sh --env dev --from-registry main-abc
rc_is "NEGATIVE TWIN: DEV_NODE=g2i8 (default) on an m2i.4 node exits 1" 1
check "it names the mismatch" "DEV_NODE_MISMATCH — DEV_NODE=g2i8 expects g2i.8, the dev node is m2i.4" "$out"
absent "no helm upgrade" "helm --kube-context dmagosdev upgrade" "$log"
deploy env DEV_PRIVATE_VALUES="$TMP/private.yaml" DEV_NODE=m2i4 bash scripts/deploy.sh --env dev --from-registry main-abc
check "DEV_NODE=m2i4 on the m2i.4 node passes the flavour check" "dev node flavour m2i.4 matches DEV_NODE=m2i4" "$out"
rm -f "$FAKE_DIR/flavour-dmagosdev"
deploy env DEV_PRIVATE_VALUES="$TMP/private.yaml" bash scripts/deploy.sh --env dev --from-registry main-abc
check "an unreadable node flavour is refused, not guessed" "DEV_NODE_UNKNOWN" "$out"

echo "== deploy.sh deploys only the digest it is told (EXPECT_DIGEST)"
deploy env EXPECT_DIGEST=sha256:4444444444444444444444444444444444444444444444444444444444444444 bash scripts/deploy.sh --env prod --from-registry 9.9.9
rc_is "NEGATIVE TWIN: a tag that resolves to another digest exits 1" 1
check "it is refused as not dev-tested" "DIGEST_NOT_DEV_TESTED" "$out"
absent "before any cluster call" "helm " "$log"
deploy env EXPECT_DIGEST=sha256:3333333333333333333333333333333333333333333333333333333333333333 bash scripts/deploy.sh --verify-only 9.9.9
rc_is "the matching digest passes" 0

echo "== smoke-test.sh and rollback.sh use the same guard"
out=$(PATH="$BIN:$PATH" DEV_KUBE_CONTEXT=dmagenticos bash scripts/smoke-test.sh --env dev 2>&1); rc=$?
rc_is "NEGATIVE TWIN: smoke --env dev with the production context exits 1" 1
check "with the guard's reason" "dev can never deploy to production" "$out"
: > "$FAKE_LOG"
out=$(PATH="$BIN:$PATH" DEV_KUBE_CONTEXT=dmagenticos bash scripts/rollback.sh --env dev 2>&1); rc=$?
check "rollback names the guard" "ROLLBACK_REFUSED: ENV_GUARD_REFUSED" "$out"
rc_is "NEGATIVE TWIN: rollback --env dev with the production context exits 1" 1
absent "no helm rollback is run" "helm --kube-context dmagenticos rollback" "$(cat "$FAKE_LOG")"

echo "== the acceptance harness refuses the production context"
out=$(E2E_KUBE_CONTEXT=dmagenticos node -e "import('./tests/e2e/kind/lib/kube.mjs').then(()=>console.log('LOADED'),e=>console.log(e.message))" 2>&1)
check "NEGATIVE TWIN: E2E_KUBE_CONTEXT=dmagenticos is refused at import" "E2E_REFUSED" "$out"
out=$(E2E_KUBE_CONTEXT=dmagosdev node -e "import('./tests/e2e/kind/lib/kube.mjs').then(m=>console.log('LOADED', m.CONTEXT))" 2>&1)
check "the dev context loads" "LOADED dmagosdev" "$out"

echo "== the acceptance harness on a real cluster: guarded, and stub journeys skipped with a reason"
reset; kube dmagenticos "$PROD"; kube dmagosdev "$DEV" dev
R=$(mktemp -d "$TMP/rep.XXXX")
out=$(PATH="$BIN:$PATH" E2E_KUBE_CONTEXT=dmagenticos E2E_REPORT_DIR=$R bash tests/e2e/kind/run.sh journeys/journey-a-knowledge.e2e.mjs 2>&1); rc=$?
rc_is "NEGATIVE TWIN: run.sh with E2E_KUBE_CONTEXT=dmagenticos exits 1" 1
check "it is refused before any journey" "E2E_REFUSED" "$out"
out=$(PATH="$BIN:$PATH" E2E_KUBE_CONTEXT=dmagosdev E2E_REPORT_DIR=$R bash tests/e2e/kind/run.sh journeys/journey-a-knowledge.e2e.mjs journeys/journey-c-approval.e2e.mjs 2>&1); rc=$?
rc_is "on the marked dev cluster the stub journeys are skipped, exit 0" 0
check "with the reason in the report" "needs the kind-only scriptable model stub" "$(cat "$R/report.md")"
check "and counted" "Journeys skipped: 2" "$(cat "$R/report.md")"

finish env-guard.test.sh || exit 1
echo "ENV_GUARD_TESTS_OK"
